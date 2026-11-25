import type { Candidate, CandidateStats, ChosenTrail, DifficultyTarget, LngLat, PlanRequest, PlanResponse, SurfaceKind, SurfaceSegment, TfTrail } from "../shared/types.ts";
import { buildCustomModel } from "./models.ts";
import { bearing, centroid, distToSegment, haversine, mulberry32, pointInPolygon, randomPointIn } from "./geo.ts";
import { geometry, trailQuality, trails as allTrails, trailsAlong, trailsInPolygon } from "./trailforks.ts";
import { hasStravaData, routeKnowledge, visitCount } from "./strava.ts";
import { findSpurs, type Spur } from "./spurs.ts";
import { brouterRoute } from "./brouter.ts";

/**
 * Peso de un sendero como candidato a punto de paso según el control de novedad.
 *  novelty > 0 → favorece lo que nunca has hecho
 *  novelty < 0 → favorece la calidad Trailforks y tus favoritos (≥ 3 veces)
 */
function noveltyWeight(t: TfTrail, novelty: number): number {
  const q = trailQuality(t);
  if (!hasStravaData() || novelty === 0) return q;
  const n = visitCount(t.longitude, t.latitude);
  if (novelty > 0) return q * (n > 0 ? 1 - 0.92 * novelty : 1 + 1.5 * novelty);
  const a = -novelty;
  return q ** (1 + a) * (n >= 3 ? 1 + 1.5 * a : n > 0 ? 1 + 0.5 * a : 1);
}

const GH = process.env.GH_URL ?? "http://localhost:8989";
const DEFAULT_ENGINE = (process.env.ROUTE_ENGINE ?? "graphhopper") as "graphhopper" | "brouter";

/** Factor típico entre distancia en línea recta y distancia real por caminos de montaña */
const DETOUR = 1.35;

// ── Modelo de batería (aproximado; se calibrará con actividades de Strava) ──────────────
// ~100 kg ciclista+bici: subir 1 m = 0,27 Wh mecánicos; el motor aporta ~60 % con ~80 % de eficiencia
const WH_PER_KM = 5;
const WH_PER_M_CLIMB = 0.22;
const MODE_FACTOR = { eco: 0.6, tour: 0.85, emtb: 1.0, turbo: 1.4 } as const;

/**
 * Desnivel acumulado robusto al ruido del SRTM: media móvil por distancia (±75 m)
 * y solo se cuentan cambios de más de 5 m (histéresis), como hacen Strava/Garmin.
 */
function climbStats(c: [number, number, number][], segLen: number[]) {
  const cum: number[] = [0];
  for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + segLen[i]);
  const smooth: number[] = [];
  let lo = 0, hi = 0, sum = 0;
  for (let i = 0; i < c.length; i++) {
    while (hi < c.length && cum[hi] <= cum[i] + 75) sum += c[hi++][2] ?? 0;
    while (cum[lo] < cum[i] - 75) sum -= c[lo++][2] ?? 0;
    smooth.push(sum / (hi - lo));
  }
  let up = 0, down = 0, ref = smooth[0] ?? 0;
  for (const e of smooth) {
    if (e - ref >= 5) { up += e - ref; ref = e; }
    else if (ref - e >= 5) { down += ref - e; ref = e; }
  }
  return { up, down };
}

interface GhPath {
  distance: number;
  time: number;
  ascend: number;
  descend: number;
  points: { coordinates: [number, number, number][] };
  details: Record<string, [number, number, string | number][]>;
}

class GhError extends Error {}

async function ghRouteOnce(points: LngLat[], customModel: object, hints: Record<string, unknown>): Promise<GhPath[]> {
  const res = await fetch(`${GH}/route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profile: "emtb",
      points,
      points_encoded: false,
      elevation: true,
      instructions: false,
      details: ["road_class", "mtb_rating"],
      custom_model: customModel,
      "ch.disable": true,
      ...hints,
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new GhError(json.message ?? `GraphHopper ${res.status}`);
  return json.paths as GhPath[];
}

/**
 * Calcula la ruta evitando dar media vuelta en los puntos de paso (pass_through).
 * Si un punto está en un ramal sin salida no hay forma de cumplirlo: entonces se repite sin esa
 * restricción y el detector de callejones se encarga después.
 */
async function ghRoute(points: LngLat[], customModel: object, hints: Record<string, unknown> = {}): Promise<GhPath[]> {
  if (points.length > 2 && !hints.algorithm) {
    try {
      return await ghRouteOnce(points, customModel, { pass_through: true, ...hints });
    } catch { /* se reintenta sin pass_through */ }
  }
  return ghRouteOnce(points, customModel, hints);
}

/**
 * Motor de rutas: GraphHopper (por defecto) o BRouter. Ambos devuelven el mismo formato,
 * así que el resto del planificador no cambia.
 */
async function engineRoute(points: LngLat[], req: PlanRequest, model: object, hints: Record<string, unknown> = {}): Promise<GhPath[]> {
  if ((req.engine ?? DEFAULT_ENGINE) === "brouter") {
    if (hints.algorithm === "alternative_route") {
      const alts = await Promise.allSettled([0, 1, 2].map((a) => brouterRoute(points, req, a)));
      const ok = alts.filter((r): r is PromiseFulfilledResult<GhPath> => r.status === "fulfilled").map((r) => r.value);
      if (!ok.length) throw new GhError("BRouter no encontró ruta");
      return ok;
    }
    return [await brouterRoute(points, req)];
  }
  return ghRoute(points, model, hints);
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = { status: "fulfilled", value: await fn(items[idx]) }; }
      catch (e) { out[idx] = { status: "rejected", reason: e }; }
    }
  }));
  return out;
}

// ── Generación de puntos de paso ─────────────────────────────────────────────────────────

/**
 * Un "bloque" de puntos de paso que se recorre junto y en orden:
 *  - 1 punto: paso suelto (del usuario o elegido al azar)
 *  - varios: sendero elegido que se quiere hacer entero (entrada → intermedios → salida)
 */
type Unit = LngLat[];

/** Bloque para un sendero elegido: su trazado OSM orientado en bajada, o solo su punto si no hay trazado */
function trailUnit(m: { id: number; point: LngLat }): { unit: Unit; whole: boolean } {
  const g = geometry[m.id];
  if (!g || g.c.length < 2) return { unit: [m.point], whole: false };
  const c = g.c as LngLat[];
  const cum = [0];
  for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + haversine(c[i - 1], c[i]));
  const total = cum[cum.length - 1];
  const at = (f: number) => c[Math.max(0, cum.findIndex((d) => d >= f * total))];
  // Entrada y salida; en senderos de más de 250 m, también dos puntos intermedios para que no se salga
  const unit: Unit = total > 250 ? [c[0], at(1 / 3), at(2 / 3), c[c.length - 1]] : [c[0], c[c.length - 1]];
  return { unit, whole: true };
}

const unitAnchor = (u: Unit) => centroid(u);

/** Ordena bloques alrededor de su centro (bucle sin cruces), en un sentido u otro, y los aplana */
function loopOrderUnits(start: LngLat, units: Unit[], reverse = false): LngLat[] {
  const c = centroid([start, ...units.map(unitAnchor)]);
  const a0 = bearing(c, start);
  const norm = (a: number) => ((a - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const sorted = [...units].sort((p, q) => norm(bearing(c, unitAnchor(p))) - norm(bearing(c, unitAnchor(q))));
  return (reverse ? sorted.reverse() : sorted).flat();
}

/** Para A→B: bloques ordenados por su proyección sobre el eje salida-llegada */
function orderForABUnits(a: LngLat, b: LngLat, units: Unit[]): LngLat[] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const proj = (u: Unit) => { const p = unitAnchor(u); return (p[0] - a[0]) * dx + (p[1] - a[1]) * dy; };
  return [...units].sort((p, q) => proj(p) - proj(q)).flat();
}

/** Bucle en el sentido (horario / antihorario) que da menos recorrido en línea recta */
function bestLoop(start: LngLat, units: Unit[]): LngLat[] {
  const a = loopOrderUnits(start, units), b = loopOrderUnits(start, units, true);
  return straightLength([start, ...a, start]) <= straightLength([start, ...b, start]) ? a : b;
}

function straightLength(seq: LngLat[]): number {
  let d = 0;
  for (let i = 1; i < seq.length; i++) d += haversine(seq[i - 1], seq[i]);
  return d;
}

function weightedPick(items: TfTrail[], w: number[], rand: () => number): TfTrail {
  let r = rand() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) if ((r -= w[i]) <= 0) return items[i];
  return items[items.length - 1];
}

/**
 * Propone conjuntos de puntos de paso dentro de la zona preferida, cuya longitud en línea recta
 * (salida → puntos → llegada/salida) se acerque a la distancia objetivo.
 * Prioriza senderos de Trailforks populares de la zona.
 */
function zoneViaSets(req: PlanRequest, zone: LngLat[], count: number, baseUnits: Unit[]): LngLat[][] {
  const allowed = (p: LngLat) => !req.avoidZones.some((z) => z.length >= 3 && pointInPolygon(p, z));
  const inside = trailsInPolygon(zone, pointInPolygon).filter((t) => allowed([t.longitude, t.latitude]));
  const weights = inside.map((t) => noveltyWeight(t, req.novelty) * difficultyWeight(t, req.difficultyTarget));
  const rand = mulberry32(1234 + Math.round(req.targetKm * 10) + Math.round(req.novelty * 100));
  // En modo novedad, los puntos aleatorios por sitios ya recorridos se descartan a menudo
  const randomOk = (p: LngLat) =>
    !(req.novelty > 0 && hasStravaData() && visitCount(p[0], p[1]) > 0 && rand() < req.novelty);
  const targetStraight = (req.targetKm * 1000) / DETOUR;
  const finish = req.end ?? req.start;

  const sets: { pts: LngLat[]; err: number }[] = [];
  for (let attempt = 0; attempt < 1500; attempt++) {
    // 2..4 puntos al azar; si ya hay varios obligatorios (pasos / senderos elegidos), 0..2 más
    const k = baseUnits.length >= 2 ? Math.floor(rand() * 3) : 2 + Math.floor(rand() * 3);
    const units: Unit[] = [...baseUnits];
    for (let j = 0; j < k; j++) {
      const fromTrail = inside.length >= 3 && rand() < 0.8;
      const p = fromTrail
        ? (() => { const t = weightedPick(inside, weights, rand); return [t.longitude, t.latitude] as LngLat; })()
        : randomPointIn(zone, rand);
      if (p && allowed(p) && (fromTrail || randomOk(p))) units.push([p]);
    }
    if (!units.length) continue;
    const ordered = req.end ? orderForABUnits(req.start, req.end, units) : bestLoop(req.start, units);
    const len = straightLength([req.start, ...ordered, finish]);
    const err = Math.abs(len - targetStraight) / targetStraight;
    sets.push({ pts: ordered, err });
  }
  sets.sort((a, b) => a.err - b.err);

  // Elegimos los mejores, pero diversos (centros separados al menos 1,5 km)
  const chosen: LngLat[][] = [];
  for (const s of sets) {
    const c = centroid(s.pts);
    if (chosen.every((o) => haversine(centroid(o), c) > 1500 || o.length !== s.pts.length)) chosen.push(s.pts);
    if (chosen.length >= count) break;
  }
  return chosen;
}

function circle(c: LngLat, meters: number, n = 32): LngLat[] {
  const dLat = meters / 111320, dLon = meters / (111320 * Math.cos((c[1] * Math.PI) / 180));
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [c[0] + dLon * Math.sin(a), c[1] + dLat * Math.cos(a)] as LngLat;
  });
}

// ── Métricas de cada candidata ───────────────────────────────────────────────────────────

const OFFROAD_SENDA = new Set(["PATH", "BRIDLEWAY", "FOOTWAY", "STEPS", "CYCLEWAY", "PEDESTRIAN"]);

type Knowledge = ReturnType<typeof routeKnowledge> | null;

function surfaceKind(raw: string | number): SurfaceKind {
  const rc = String(raw).toUpperCase();
  return OFFROAD_SENDA.has(rc) ? "senda" : rc === "TRACK" ? "pista" : "asfalto";
}

/** Tramos consecutivos del mismo tipo de vía, como rangos de índices de la geometría. */
function surfaceSegments(path: GhPath): SurfaceSegment[] {
  const out: SurfaceSegment[] = [];
  for (const [from, to, raw] of path.details.road_class ?? []) {
    const kind = surfaceKind(raw);
    const last = out[out.length - 1];
    if (last && last[2] === kind && last[1] === from) last[1] = to;
    else out.push([from, to, kind]);
  }
  return out;
}

/**
 * Sitúa un sendero de Trailforks sobre la ruta. Trailforks solo da un punto y la longitud,
 * así que buscamos el punto de la ruta más cercano y tomamos un tramo de esa longitud hacia
 * el lado que más se parece al tipo de sendero (senda para senderos, pista para accesos).
 */
function locateTrail(t: TfTrail, c: number[][], cum: number[], kindAt: SurfaceKind[]): { at: number; range: [number, number] } {
  // Con trazado OSM: el tramo de la ruta entre los puntos más cercanos a su inicio y su final
  const g = geometry[t.trailid];
  if (g && g.c.length >= 2) {
    const near = (q: number[]) => {
      let best = Infinity, idx = 0;
      for (let i = 0; i < c.length; i++) { const d = haversine(c[i], q); if (d < best) { best = d; idx = i; } }
      return { idx, d: best };
    };
    const a = near(g.c[0]), b = near(g.c[g.c.length - 1]);
    if (a.d < 60 && b.d < 60 && a.idx !== b.idx) return { at: a.idx, range: [Math.min(a.idx, b.idx), Math.max(a.idx, b.idx)] };
  }
  const p = [t.longitude, t.latitude];
  let at = 0, best = Infinity;
  for (let i = 1; i < c.length; i++) {
    const d = distToSegment(p, c[i - 1], c[i]);
    if (d < best) { best = d; at = haversine(p, c[i - 1]) < haversine(p, c[i]) ? i - 1 : i; }
  }
  const L = Math.min(4000, Math.max(80, t.distance_m ?? 300));
  const want: SurfaceKind = t.difficulty === 1 || t.difficulty === 7 ? "pista" : "senda";
  let fwd = at; while (fwd < c.length - 1 && cum[fwd] - cum[at] < L) fwd++;
  let back = at; while (back > 0 && cum[at] - cum[back] < L) back--;
  const match = (a: number, b: number) => {
    let ok = 0, tot = 0;
    for (let i = a + 1; i <= b; i++) { const d = cum[i] - cum[i - 1]; tot += d; if (kindAt[i] === want) ok += d; }
    return tot ? ok / tot : 0;
  };
  const mf = match(at, fwd), mb = match(back, at);
  if (Math.abs(mf - mb) < 0.1) {
    // empate: tramo centrado en el punto
    let a = at, b = at;
    while (a > 0 && cum[at] - cum[a] < L / 2) a--;
    while (b < c.length - 1 && cum[b] - cum[at] < L / 2) b++;
    return { at, range: [a, b] };
  }
  return { at, range: mf > mb ? [at, fwd] : [back, at] };
}

function computeStats(path: GhPath, req: PlanRequest, tf: TfTrail[], know: Knowledge): CandidateStats {
  const c = path.points.coordinates;
  const spurs: Spur[] = deadEnds(c);
  const segLen: number[] = [0];
  for (let i = 1; i < c.length; i++) segLen.push(haversine(c[i - 1], c[i]));
  const lenBetween = (from: number, to: number) => { let s = 0; for (let i = from + 1; i <= to; i++) s += segLen[i]; return s; };

  const surface = { senda: 0, pista: 0, asfalto: 0 };
  for (const [from, to, raw] of path.details.road_class ?? []) surface[surfaceKind(raw)] += lenBetween(from, to) / 1000;
  let technicalKm = 0;
  for (const [from, to, r] of path.details.mtb_rating ?? []) if (Number(r) >= 3) technicalKm += lenBetween(from, to) / 1000;

  let insideZonePct: number | null = null;
  if (req.prefZone) {
    let inside = 0;
    for (let i = 1; i < c.length; i++) {
      const mid: LngLat = [(c[i - 1][0] + c[i][0]) / 2, (c[i - 1][1] + c[i][1]) / 2];
      if (pointInPolygon(mid, req.prefZone.polygon)) inside += segLen[i];
    }
    insideZonePct = (100 * inside) / path.distance;
  }

  // Tramos repetidos dentro de la misma ruta (ida y vuelta por el mismo sitio)
  const seen = new Map<string, number>();
  let overlap = 0;
  for (let i = 0; i < c.length; i++) {
    const k = `${Math.round(c[i][0] / 0.0003)}:${Math.round(c[i][1] / 0.00025)}`;
    const first = seen.get(k);
    if (first === undefined) seen.set(k, i);
    else if (i - first > 25 && i > 0) overlap += segLen[i];
  }

  const km = path.distance / 1000;
  const climb = climbStats(c, segLen);
  const batteryWh = (km * WH_PER_KM + climb.up * WH_PER_M_CLIMB) * MODE_FACTOR[req.battery.mode];

  return {
    distanceKm: km,
    ascentM: climb.up,
    descentM: climb.down,
    timeMin: path.time / 60000,
    surface,
    technicalKm,
    batteryWh,
    batteryLeftPct: 100 * (1 - batteryWh / req.battery.wh),
    insideZonePct,
    overlapPct: (100 * overlap) / path.distance,
    trailforksCount: tf.length,
    deadEnds: spurs.map((s) => ({ from: s.base, to: s.end, lengthM: Math.round(s.lengthM) })),
    newPct: know ? 100 * (1 - know.knownM / Math.max(1, know.totalM)) : null,
    newKm: know ? (know.totalM - know.knownM) / 1000 : null,
  };
}

type RawCandidate = Omit<Candidate, "score" | "scoreParts"> & { favPct: number };

// ── Objetivo de dificultad ───────────────────────────────────────────────────────────────

/** Nivel de un sendero Trailforks: 0 fácil, 1 medio, 2 difícil, 3 extremo (null = acceso/sin dato) */
export function tfLevel(difficultyId: number): number | null {
  if (difficultyId === 2 || difficultyId === 3) return 0;
  if (difficultyId === 4) return 1;
  if (difficultyId === 5 || difficultyId === 10 || difficultyId === 11) return 2;
  if (difficultyId === 6 || difficultyId === 8) return 3;
  return null;
}
const TARGET_LEVEL: Record<DifficultyTarget, number> = { facil: 0, media: 1, dificil: 2 };
/** Cuánto atrae un sendero según su nivel y el objetivo de hoy */
const LEVEL_WEIGHT: Record<DifficultyTarget, number[]> = {
  facil: [2.2, 0.6, 0.12, 0.03],
  media: [0.8, 2.2, 0.9, 0.25],
  dificil: [0.3, 1.0, 2.6, 2.0],
};
/** Desnivel por km que encaja con cada objetivo (m/km) */
const CLIMB_RANGE: Record<DifficultyTarget, [number, number]> = { facil: [0, 22], media: [15, 35], dificil: [28, 80] };

export function difficultyWeight(t: TfTrail, target: DifficultyTarget): number {
  const lvl = tfLevel(t.difficulty);
  return lvl === null ? 1 : LEVEL_WEIGHT[target][lvl];
}

function difficultyMatch(c: RawCandidate, target: DifficultyTarget): number {
  const lv = c.trailforks.map((t) => tfLevel(t.difficultyId)).filter((x): x is number => x !== null);
  const want = TARGET_LEVEL[target];
  const tech = lv.length ? lv.reduce((s, l) => s + (l === want || (want === 2 && l === 3) ? 1 : Math.abs(l - want) === 1 ? 0.4 : 0), 0) / lv.length : 0.5;
  const perKm = c.stats.ascentM / Math.max(1, c.stats.distanceKm);
  const [lo, hi] = CLIMB_RANGE[target];
  const phys = perKm < lo ? Math.max(0, 1 - (lo - perKm) / 15) : perKm > hi ? Math.max(0, 1 - (perKm - hi) / 15) : 1;
  return 0.7 * tech + 0.3 * phys;
}

function scoreCandidates(cands: RawCandidate[], req: PlanRequest): Candidate[] {
  const tfScores = cands.map((c) => c.trailforks.reduce((s, t) => s + Math.log1p(t.checkins ?? 0) + 1, 0));
  const maxTf = Math.max(1, ...tfScores);
  const a = Math.abs(req.novelty);
  return cands.map(({ favPct, ...c }, i) => {
    const s = c.stats;
    const parts: Record<string, number> = {};
    parts.distancia = 30 * Math.max(0, 1 - Math.abs(s.distanceKm - req.targetKm) / req.targetKm);
    parts.trailforks = 25 * (tfScores[i] / maxTf) * (req.novelty < 0 ? 1 + 0.8 * a : 1);
    parts.dificultad = 30 * difficultyMatch({ favPct, ...c }, req.difficultyTarget);
    if (s.newPct !== null && req.novelty > 0) parts.novedad = 55 * req.novelty * (s.newPct / 100);
    if (s.newPct !== null && req.novelty < 0) parts.favoritos = 15 * a * (favPct / 100);
    const offroad = (s.surface.senda + s.surface.pista) / Math.max(0.1, s.distanceKm);
    const senda = s.surface.senda / Math.max(0.1, s.distanceKm);
    parts.terreno = req.routeType === "gravel" ? 15 * offroad
      : req.routeType === "enduro" ? 10 * offroad + 10 * Math.min(1, senda * 2.5)
      : 15 * offroad;
    if (s.insideZonePct !== null) parts.zona = 20 * (s.insideZonePct / 100);
    if (c.chosen.length) {
      // Sendero con trazado: cuenta lo que se recorre de él (y penaliza hacerlo en sentido contrario).
      // Sin trazado: basta con pasar por su punto.
      const per = c.chosen.map((t) => t.whole ? (t.coverage ?? 0) * (t.rightWay === false ? 0.15 : 1) : (t.passes ? 1 : 0));
      parts.elegidos = 35 * (per.reduce((a, b) => a + b, 0) / per.length);
    }
    parts.repeticion = -30 * (s.overlapPct / 100);
    // Callejones: cada uno resta 6 puntos + 15 por km de ida (1 km de ida y vuelta ≈ -21)
    if (s.deadEnds.length) parts.callejones = -s.deadEnds.reduce((sum, d) => sum + 6 + 15 * (d.lengthM / 1000), 0);
    if (s.batteryLeftPct < 10) parts.bateria = -40;
    else if (s.batteryLeftPct < 20) parts.bateria = -10;
    const score = Object.values(parts).reduce((x, y) => x + y, 0);
    return { ...c, score: Math.round(score * 10) / 10, scoreParts: parts };
  }).sort((x, y) => y.score - x.score);
}

/** Construye una candidata (estadísticas, senderos, tramos) a partir de una ruta de GraphHopper. */
function buildCandidate(path: GhPath, via: LngLat[], req: PlanRequest, id: string): RawCandidate {
  const strava = hasStravaData();
  const c = path.points.coordinates;
  const tf = trailsAlong(c);
  const know = strava ? routeKnowledge(c) : null;
  const segments = surfaceSegments(path);
  const cum: number[] = [0];
  for (let k = 1; k < c.length; k++) cum.push(cum[k - 1] + haversine(c[k - 1], c[k]));
  const kindAt: SurfaceKind[] = new Array(c.length).fill("asfalto");
  for (const [from, to, kind] of segments) for (let k = from + 1; k <= to; k++) kindAt[k] = kind;
  return {
    id,
    coords: c,
    stats: computeStats(path, req, tf, know),
    trailforks: tf.map((t) => ({
      id: t.trailid, title: t.title, url: t.url, difficulty: t.difficulty_label, difficultyId: t.difficulty,
      region: t.region_title, checkins: t.total_checkins, rating: t.rating, lengthM: t.distance_m ?? undefined,
      importance: trailQuality(t),
      ridden: strava ? visitCount(t.longitude, t.latitude) : undefined,
      ...locateTrail(t, c, cum, kindAt),
    })).sort((x, y) => y.importance - x.importance),
    surfaceSegments: segments,
    via,
    knownRanges: know?.ranges ?? [],
    favPct: know ? (100 * know.favM) / Math.max(1, know.totalM) : 0,
    chosen: chosenCoverage(req, c),
  };
}

function normalize(req: PlanRequest) {
  req.novelty = Math.max(-1, Math.min(1, Number(req.novelty) || 0));
  if (!["facil", "media", "dificil"].includes(req.difficultyTarget)) req.difficultyTarget = "media";
  req.mustTrails = Array.isArray(req.mustTrails) ? req.mustTrails : [];
}

function remember(c: Candidate, req: PlanRequest, i: number) {
  recent.set(c.id, { candidate: c, name: routeName(req, c, i) });
  while (recent.size > 80) recent.delete(recent.keys().next().value!);
}

const trailName = (id: number) => allTrails.find((t) => t.trailid === id)?.title ?? `#${id}`;

/**
 * ¿Cuánto de cada sendero elegido recorre la ruta y en qué sentido?
 * Muestrea su trazado cada ~20 m y mira qué puntos quedan a menos de 30 m de la ruta.
 */
function chosenCoverage(req: PlanRequest, c: number[][]): ChosenTrail[] {
  if (!req.mustTrails.length) return [];
  const CELL = 0.0004;
  const grid = new Map<string, number[]>();
  c.forEach((p, i) => {
    const k = `${Math.floor(p[0] / CELL)}:${Math.floor(p[1] / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(i);
  });
  const nearest = (p: number[]) => {
    const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
    let best = Infinity, idx = -1;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
      for (const i of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
        const d = haversine(c[i], p);
        if (d < best) { best = d; idx = i; }
      }
    return { d: best, idx };
  };
  return req.mustTrails.map((m) => {
    const g = geometry[m.id];
    if (!g || g.c.length < 2) {
      return { id: m.id, title: trailName(m.id), whole: false, coverage: null, rightWay: null, passes: nearest(m.point).d < 60 };
    }
    const samples: number[][] = [g.c[0]];
    for (let i = 1; i < g.c.length; i++) {
      const d = haversine(g.c[i - 1], g.c[i]);
      for (let s = 20; s < d; s += 20) {
        const f = s / d;
        samples.push([g.c[i - 1][0] + (g.c[i][0] - g.c[i - 1][0]) * f, g.c[i - 1][1] + (g.c[i][1] - g.c[i - 1][1]) * f]);
      }
      samples.push(g.c[i]);
    }
    const hits = samples.map(nearest);
    const covered = hits.filter((h) => h.d < 30);
    const coverage = covered.length / samples.length;
    // Sentido: los puntos cubiertos deben aparecer en la ruta en el mismo orden que en el trazado
    let forward = 0, backward = 0;
    for (let i = 1; i < covered.length; i++) {
      if (covered[i].idx > covered[i - 1].idx) forward++;
      else if (covered[i].idx < covered[i - 1].idx) backward++;
    }
    return {
      id: m.id, title: trailName(m.id), whole: true, coverage,
      rightWay: covered.length >= 2 ? forward >= backward : null,
      passes: coverage > 0.2, ride: g.ride,
    };
  });
}

// ── Callejones (ida y vuelta por el mismo sitio) ─────────────────────────────────────────

/** Callejones que cuentan: giros en redondo de más de 120 m */
const deadEnds = (c: number[][]) => {
  const giros = findSpurs(c).filter((s) => s.kind === "giro" && s.lengthM >= 120);
  // Un mismo ida-y-vuelta largo aparece como varios callejones anidados: nos quedamos con el exterior
  return giros.filter((s) => !giros.some((o) => o !== s && o.base <= s.base && o.end >= s.end && o.lengthM > s.lengthM));
};

/** Índice de la ruta más cercano a cada punto de paso, en orden de recorrido */
function viaIndices(c: number[][], via: LngLat[]): number[] {
  const out: number[] = [];
  let from = 0;
  for (const v of via) {
    let best = Infinity, idx = from;
    for (let i = from; i < c.length; i++) {
      const d = haversine(c[i], v);
      if (d < best) { best = d; idx = i; }
    }
    out.push(idx);
    from = idx;
  }
  return out;
}

/**
 * Calcula la ruta y, si algún punto de paso elegido automáticamente obliga a meterse en un ramal
 * sin salida y volver, lo mueve al cruce donde empieza el ramal y recalcula (hasta 3 veces).
 * Los puntos fijados por el usuario no se tocan.
 */
async function routeWithoutDeadEnds(req: PlanRequest, model: object, via0: LngLat[], fixed: Set<string>, soft: Set<string> = new Set()) {
  let via = via0;
  let [path] = await engineRoute([req.start, ...via, req.end ?? req.start], req, model);
  let repaired = 0;
  for (let iter = 0; iter < 3; iter++) {
    const c = path.points.coordinates;
    const spurs = deadEnds(c);
    if (!spurs.length) break;
    const idx = viaIndices(c, via);
    let changed = false;
    const next = via.map((p, k): LngLat | null => {
      const key = p.join(",");
      // el callejón más grande que contiene este punto (el exterior)
      const sp = spurs.filter((s) => idx[k] >= s.base - 2 && idx[k] <= s.end + 2).sort((x, y) => y.lengthM - x.lengthM)[0];
      if (!sp) return p;
      // Punto intermedio de un sendero elegido que GraphHopper no puede seguir: se quita
      if (soft.has(key)) { changed = true; return null; }
      if (fixed.has(key)) return p;
      changed = true;
      return [c[sp.base][0], c[sp.base][1]] as LngLat;
    }).filter((p): p is LngLat => p !== null).filter((p, k, arr) => k === 0 || haversine(p, arr[k - 1]) > 30);
    if (!changed) break;
    via = next;
    repaired++;
    [path] = await engineRoute([req.start, ...via, req.end ?? req.start], req, model);
  }
  return { path, via, repaired };
}

// ── Plan principal ───────────────────────────────────────────────────────────────────────

export async function plan(req: PlanRequest): Promise<PlanResponse> {
  normalize(req);
  const warnings: string[] = [];
  const model = buildCustomModel(req);
  const circular = !req.end;
  const jobs: { via: LngLat[]; hints?: Record<string, unknown> }[] = [];

  // Bloques obligatorios: pasos del usuario (sueltos) + senderos elegidos (enteros si tienen trazado)
  const trailUnits = req.mustTrails.map((m) => ({ m, ...trailUnit(m) }));
  const baseUnits: Unit[] = [...req.waypoints.map((p) => [p]), ...trailUnits.map((t) => t.unit)];
  req.waypoints = baseUnits.flat();
  const pointOnly = trailUnits.filter((t) => !t.whole).map((t) => trailName(t.m.id));
  if (pointOnly.length)
    warnings.push(`Sin trazado en el mapa: ${pointOnly.join(", ")}. La ruta solo pasa por su punto de referencia; comprueba que lo recorre entero.`);

  if (req.novelty !== 0 && !hasStravaData()) warnings.push("El control de novedad necesita tus datos de Strava: conéctalo y sincroniza.");
  // Con el control de novedad activo generamos más alternativas para que el ranking tenga donde elegir
  const nCands = hasStravaData() && Math.abs(req.novelty) > 0.3 ? 16 : 9;

  if (req.prefZone && req.prefZone.polygon.length >= 3) {
    for (const via of zoneViaSets(req, req.prefZone.polygon, nCands, baseUnits)) jobs.push({ via });
    if (!pointInPolygon(req.start, req.prefZone.polygon))
      warnings.push("La salida está fuera de la zona preferida: la ruta incluye aproximación y regreso.");
  } else if (circular && req.waypoints.length === 0) {
    // Sin zona: buscamos bucles que pasen por senderos de Trailforks dentro de un círculo alcanzable
    const radius = (req.targetKm * 1000) / (2 * DETOUR);
    for (const via of zoneViaSets(req, circle(req.start, radius), nCands, baseUnits)) jobs.push({ via });
  } else if (circular) {
    // Los dos sentidos del bucle (cada sendero mantiene su sentido de bajada)
    jobs.push({ via: loopOrderUnits(req.start, baseUnits) }, { via: loopOrderUnits(req.start, baseUnits, true) });
  } else if (req.waypoints.length === 0) {
    jobs.push({ via: [], hints: { algorithm: "alternative_route", "alternative_route.max_paths": 3, "alternative_route.max_weight_factor": 2 } });
  } else {
    jobs.push({ via: orderForABUnits(req.start, req.end!, baseUnits) });
  }

  // Puntos que ha fijado el usuario (pasos, entrada y salida de senderos elegidos): nunca se mueven.
  // Los intermedios de los senderos son "blandos": si provocan un callejón, se quitan.
  const soft = new Set(trailUnits.filter((t) => t.whole).flatMap((t) => t.unit.slice(1, -1)).map((p) => p.join(",")));
  const fixed = new Set(req.waypoints.map((p) => p.join(",")).filter((k) => !soft.has(k)));
  const results = await pool(jobs, 4, async (job) => {
    if (job.hints?.algorithm) {
      const paths = await engineRoute([req.start, ...job.via, req.end ?? req.start], req, model, job.hints);
      return paths.map((p) => ({ path: p, via: job.via, repaired: 0 }));
    }
    const r = await routeWithoutDeadEnds(req, model, job.via, fixed, soft);
    return [{ path: r.path, via: r.via, repaired: r.repaired }];
  });

  const raw: RawCandidate[] = [];
  const errors = new Set<string>();
  results.forEach((r, i) => {
    if (r.status === "rejected") { errors.add(String(r.reason?.message ?? r.reason)); return; }
    r.value.forEach(({ path, via }, j) => raw.push(buildCandidate(path, via, req, `p${planCounter}-c${i}-${j}`)));
  });

  if (!raw.length) {
    throw new GhError(errors.size ? [...errors].join(" · ") : "No se encontró ninguna ruta con esas condiciones.");
  }
  if (errors.size) warnings.push(`${errors.size} propuesta(s) no se pudieron calcular.`);

  // Quitar duplicados casi idénticos
  const unique = raw.filter((c, i) => raw.findIndex((o) =>
    Math.abs(o.stats.distanceKm - c.stats.distanceKm) < 0.3 && Math.abs(o.stats.ascentM - c.stats.ascentM) < 15) === i);

  const ranked = scoreCandidates(unique, req).slice(0, 5);
  if (ranked[0] && ranked[0].stats.batteryLeftPct < 10)
    warnings.push("Ojo: según la estimación, la mejor ruta deja la batería por debajo del 10 %.");

  ranked.forEach((c, i) => remember(c, req, i));
  planCounter++;
  return { candidates: ranked, warnings };
}

/** Modo Personalizar: recalcula una ruta con los puntos de paso exactos que indica el usuario. */
export async function routeWithVia(req: PlanRequest, via: LngLat[]): Promise<Candidate> {
  normalize(req);
  const paths = await engineRoute([req.start, ...via, req.end ?? req.start], req, buildCustomModel(req));
  const [c] = scoreCandidates([buildCandidate(paths[0], via, req, `p${planCounter++}-custom`)], req);
  remember(c, req, 0);
  return c;
}

// ── GPX ──────────────────────────────────────────────────────────────────────────────────

let planCounter = 1;
const recent = new Map<string, { candidate: Candidate; name: string }>();
const TYPE_LABEL = { mixta: "Mixta", xc: "XC", enduro: "Enduro", gravel: "Gravel" } as const;

function routeName(req: PlanRequest, c: Candidate, i: number) {
  const km = Math.round(c.stats.distanceKm);
  const kind = req.end ? "AB" : "circular";
  return `eMTB ${TYPE_LABEL[req.routeType]} ${kind} ${km}km +${Math.round(c.stats.ascentM)}m (op${i + 1})`;
}

export function getRecent(id: string) {
  return recent.get(id) ?? null;
}

export { GhError };
