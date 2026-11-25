/**
 * Integración con Strava (solo lectura, uso personal).
 *
 * - OAuth con tu propia app de Strava (credenciales en .env.local, nunca en el código).
 * - Descarga tus salidas en bici: primero la traza resumida de cada actividad (1 llamada por
 *   cada 200 actividades) y después, poco a poco y respetando los límites de la API, la traza
 *   completa de las actividades de tu zona.
 * - Construye un "mapa de calor" personal: una rejilla de celdas de ~22 m con cuántas
 *   actividades distintas han pasado por cada una.
 *
 * Todo se guarda en data/strava/ (local, ignorado por git).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { distToSegment, haversine } from "./geo.ts";
import type { LngLat } from "../shared/types.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = `${ROOT}data/strava`;
const STREAMS_DIR = `${DIR}/streams`;
const TOKENS = `${DIR}/tokens.json`;
const ACTIVITIES = `${DIR}/activities.json`;
const ENV_FILE = `${ROOT}.env.local`;

const API = "https://www.strava.com/api/v3";
const BIKE_TYPES = new Set(["Ride", "MountainBikeRide", "EMountainBikeRide", "EBikeRide", "GravelRide"]);
/** Solo se descargan trazas completas de actividades que pasan a menos de esta distancia del centro */
const AREA_RADIUS_M = 55_000;
const AREA_CENTER: LngLat = [-0.302, 39.676];

// ── Configuración ────────────────────────────────────────────────────────────────────────

/** Lee .env.local en cada llamada, así no hace falta reiniciar tras editarlo. */
function config() {
  const env: Record<string, string> = {};
  if (existsSync(ENV_FILE)) {
    for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return {
    clientId: env.STRAVA_CLIENT_ID ?? process.env.STRAVA_CLIENT_ID ?? "",
    clientSecret: env.STRAVA_CLIENT_SECRET ?? process.env.STRAVA_CLIENT_SECRET ?? "",
    appUrl: env.APP_URL ?? process.env.APP_URL ?? "http://localhost:5173",
  };
}

const readJson = <T>(f: string, fallback: T): T => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : fallback);
const writeJson = (f: string, data: unknown) => { mkdirSync(DIR, { recursive: true }); writeFileSync(f, JSON.stringify(data)); };

// ── OAuth ────────────────────────────────────────────────────────────────────────────────

interface Tokens { access_token: string; refresh_token: string; expires_at: number; athlete?: { id: number; firstname?: string; lastname?: string } }
const pendingStates = new Set<string>();

export function authorizeUrl(): string | null {
  const c = config();
  if (!c.clientId) return null;
  const state = randomBytes(12).toString("hex");
  pendingStates.add(state);
  const p = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: `${c.appUrl}/api/strava/callback`,
    response_type: "code",
    approval_prompt: "auto",
    scope: "read,activity:read_all",
    state,
  });
  return `https://www.strava.com/oauth/authorize?${p}`;
}

export async function handleCallback(code: string, state: string, scope: string): Promise<string> {
  const c = config();
  if (!pendingStates.delete(state)) return "estado OAuth no válido; vuelve a intentarlo";
  if (!scope.includes("activity:read")) return "hace falta permitir el acceso a tus actividades";
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, code, grant_type: "authorization_code" }),
  });
  const json: any = await res.json();
  if (!res.ok) return json.message ?? `error ${res.status}`;
  writeJson(TOKENS, { access_token: json.access_token, refresh_token: json.refresh_token, expires_at: json.expires_at, athlete: json.athlete && { id: json.athlete.id, firstname: json.athlete.firstname, lastname: json.athlete.lastname } });
  return "ok";
}

async function accessToken(): Promise<string> {
  const t = readJson<Tokens | null>(TOKENS, null);
  if (!t) throw new Error("Strava no está conectado");
  if (t.expires_at > Date.now() / 1000 + 120) return t.access_token;
  const c = config();
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, grant_type: "refresh_token", refresh_token: t.refresh_token }),
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`No se pudo renovar el acceso a Strava: ${json.message ?? res.status}`);
  writeJson(TOKENS, { ...t, access_token: json.access_token, refresh_token: json.refresh_token, expires_at: json.expires_at });
  return json.access_token;
}

export async function disconnect() {
  const t = readJson<Tokens | null>(TOKENS, null);
  if (t) await fetch("https://www.strava.com/oauth/deauthorize", { method: "POST", headers: { Authorization: `Bearer ${t.access_token}` } }).catch(() => {});
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
  grid.clear();
  tracks = [];
}

// ── Cliente con control de límites ──────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msToNextQuarter = () => { const now = new Date(); return ((15 - (now.getUTCMinutes() % 15)) * 60 - now.getUTCSeconds()) * 1000 + 2000; };
class DailyLimit extends Error {}

async function stravaGet(path: string): Promise<any> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${await accessToken()}` } });
    const usage = (res.headers.get("x-readratelimit-usage") ?? res.headers.get("x-ratelimit-usage") ?? "").split(",").map(Number);
    const limit = (res.headers.get("x-readratelimit-limit") ?? res.headers.get("x-ratelimit-limit") ?? "").split(",").map(Number);
    if (limit.length === 2 && usage.length === 2) sync.rate = { used15: usage[0], limit15: limit[0], usedDay: usage[1], limitDay: limit[1] };

    if (res.status === 429) {
      if (sync.rate && sync.rate.usedDay >= sync.rate.limitDay) throw new DailyLimit();
      sync.phase = "pausa"; sync.message = "Límite de Strava alcanzado; sigo en el próximo cuarto de hora.";
      await sleep(msToNextQuarter());
      continue;
    }
    if (!res.ok) throw new Error(`Strava ${res.status} en ${path}`);
    const json = await res.json();
    // Frenar antes de llegar al límite
    if (sync.rate) {
      if (sync.rate.usedDay >= sync.rate.limitDay - 5) throw new DailyLimit();
      if (sync.rate.used15 >= sync.rate.limit15 - 5) {
        sync.phase = "pausa"; sync.message = "Pausa para respetar el límite de Strava (15 min).";
        await sleep(msToNextQuarter());
      }
    }
    return json;
  }
  throw new Error("Strava no responde");
}

// ── Polyline de Google (formato de Strava) ──────────────────────────────────────────────

export function decodePolyline(str: string): LngLat[] {
  const out: LngLat[] = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0, result = 0, b: number;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d; else lng += d;
    }
    out.push([lng / 1e5, lat / 1e5]);
  }
  return out;
}

// ── Actividades y sincronización ────────────────────────────────────────────────────────

export interface StoredActivity {
  id: number; name: string; sport_type: string; start_date: string;
  distance: number; total_elevation_gain: number; polyline: string; inArea: boolean;
}

export const sync = {
  running: false,
  phase: "inactivo" as "inactivo" | "actividades" | "trazas" | "pausa" | "listo" | "error",
  message: "",
  activities: 0,
  streamsDone: 0,
  streamsTotal: 0,
  rate: null as null | { used15: number; limit15: number; usedDay: number; limitDay: number },
  lastSync: null as string | null,
};

function nearArea(pts: LngLat[]): boolean {
  for (let i = 0; i < pts.length; i += 10) if (haversine(pts[i], AREA_CENTER) < AREA_RADIUS_M) return true;
  return false;
}

export async function runSync() {
  if (sync.running) return;
  Object.assign(sync, { running: true, phase: "actividades", message: "Descargando lista de actividades…" });
  try {
    const stored = readJson<StoredActivity[]>(ACTIVITIES, []);
    const known = new Set(stored.map((a) => a.id));
    const after = stored.length ? Math.floor(Math.max(...stored.map((a) => Date.parse(a.start_date))) / 1000) - 86400 : 0;

    for (let page = 1; ; page++) {
      const list: any[] = await stravaGet(`/athlete/activities?per_page=200&page=${page}${after ? `&after=${after}` : ""}`);
      for (const a of list) {
        if (known.has(a.id) || !BIKE_TYPES.has(a.sport_type ?? a.type) || !a.map?.summary_polyline) continue;
        const pts = decodePolyline(a.map.summary_polyline);
        stored.push({
          id: a.id, name: a.name, sport_type: a.sport_type ?? a.type, start_date: a.start_date,
          distance: a.distance, total_elevation_gain: a.total_elevation_gain,
          polyline: a.map.summary_polyline, inArea: nearArea(pts),
        });
        known.add(a.id);
      }
      sync.activities = stored.length;
      sync.message = `${stored.length} salidas en bici encontradas…`;
      if (list.length < 200) break;
    }
    writeJson(ACTIVITIES, stored);
    buildGrid();

    // Trazas completas (más precisas) solo de la zona, de la más reciente a la más antigua
    mkdirSync(STREAMS_DIR, { recursive: true });
    const pending = stored.filter((a) => a.inArea && !existsSync(`${STREAMS_DIR}/${a.id}.json`))
      .sort((a, b) => Date.parse(b.start_date) - Date.parse(a.start_date));
    sync.streamsTotal = stored.filter((a) => a.inArea).length;
    sync.streamsDone = sync.streamsTotal - pending.length;
    sync.phase = "trazas";
    for (const a of pending) {
      sync.phase = "trazas";
      sync.message = `Trazas detalladas: ${sync.streamsDone}/${sync.streamsTotal}`;
      try {
        const s = await stravaGet(`/activities/${a.id}/streams?keys=latlng&key_by_type=true`);
        const latlng: [number, number][] = s.latlng?.data ?? [];
        writeFileSync(`${STREAMS_DIR}/${a.id}.json`, JSON.stringify(latlng.map(([la, lo]) => [+lo.toFixed(5), +la.toFixed(5)])));
      } catch (e) {
        if (e instanceof DailyLimit) throw e;
        writeFileSync(`${STREAMS_DIR}/${a.id}.json`, "[]"); // sin traza: usaremos la resumida
      }
      sync.streamsDone++;
      if (sync.streamsDone % 25 === 0) buildGrid();
    }
    buildGrid();
    Object.assign(sync, { phase: "listo", message: "Sincronizado", lastSync: new Date().toISOString() });
  } catch (e) {
    if (e instanceof DailyLimit) {
      buildGrid();
      Object.assign(sync, { phase: "pausa", message: "Límite diario de Strava alcanzado. Vuelve a sincronizar mañana para completar las trazas." });
    } else {
      Object.assign(sync, { phase: "error", message: (e as Error).message });
    }
  } finally {
    sync.running = false;
  }
}

// ── Mapa de calor personal ──────────────────────────────────────────────────────────────

const CELL_LAT = 0.0002;   // ~22 m
const CELL_LON = 0.00026;  // ~22 m a 39.7° N
const grid = new Map<string, number>(); // celda → nº de actividades distintas
let tracks: { id: number; name: string; date: string; coords: LngLat[] }[] = [];

const cellOf = (x: number, y: number) => [Math.floor(x / CELL_LON), Math.floor(y / CELL_LAT)] as const;

function geometryOf(a: StoredActivity): LngLat[] {
  const f = `${STREAMS_DIR}/${a.id}.json`;
  if (existsSync(f)) {
    const pts = JSON.parse(readFileSync(f, "utf8")) as LngLat[];
    if (pts.length > 1) return pts;
  }
  return decodePolyline(a.polyline);
}

export function buildGrid() {
  const acts = readJson<StoredActivity[]>(ACTIVITIES, []);
  grid.clear();
  tracks = [];
  for (const a of acts) {
    const pts = geometryOf(a);
    const cells = new Set<string>();
    for (let i = 1; i < pts.length; i++) {
      const d = haversine(pts[i - 1], pts[i]);
      const steps = Math.max(1, Math.ceil(d / 10)); // densificar cada ~10 m
      for (let s = 0; s <= steps; s++) {
        const x = pts[i - 1][0] + ((pts[i][0] - pts[i - 1][0]) * s) / steps;
        const y = pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * s) / steps;
        const [cx, cy] = cellOf(x, y);
        cells.add(`${cx}:${cy}`);
      }
    }
    for (const k of cells) grid.set(k, (grid.get(k) ?? 0) + 1);
    if (a.inArea) tracks.push({ id: a.id, name: a.name, date: a.start_date, coords: simplify(pts, 15) });
  }
  sync.activities = acts.length;
  console.log(`[strava] ${acts.length} actividades, ${grid.size} celdas visitadas`);
}

/** Nº de actividades que han pasado a ~30 m del punto (celda y sus vecinas). */
export function visitCount(x: number, y: number): number {
  const [cx, cy] = cellOf(x, y);
  let best = 0;
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) best = Math.max(best, grid.get(`${cx + dx}:${cy + dy}`) ?? 0);
  return best;
}

export const hasStravaData = () => grid.size > 0;

/**
 * Cuánto de una ruta ya conoces: metros ya recorridos, metros "favoritos" (≥3 veces)
 * y tramos conocidos como rangos de índices para pintarlos en el mapa.
 */
export function routeKnowledge(coords: number[][]) {
  let known = 0, fav = 0, total = 0;
  const ranges: [number, number][] = [];
  let open = -1;
  for (let i = 1; i < coords.length; i++) {
    const d = haversine(coords[i - 1], coords[i]);
    const mid = [(coords[i - 1][0] + coords[i][0]) / 2, (coords[i - 1][1] + coords[i][1]) / 2];
    const n = visitCount(mid[0], mid[1]);
    total += d;
    if (n > 0) {
      known += d;
      if (n >= 3) fav += d;
      if (open < 0) open = i - 1;
    } else if (open >= 0) { ranges.push([open, i - 1]); open = -1; }
  }
  if (open >= 0) ranges.push([open, coords.length - 1]);
  return { knownM: known, favM: fav, totalM: total, ranges };
}

export function tracksGeoJson() {
  return {
    type: "FeatureCollection",
    features: tracks.map((t) => ({
      type: "Feature",
      properties: { id: t.id, name: t.name, date: t.date.slice(0, 10) },
      geometry: { type: "LineString", coordinates: t.coords },
    })),
  };
}

export function status() {
  const c = config();
  const t = readJson<Tokens | null>(TOKENS, null);
  return {
    configured: Boolean(c.clientId && c.clientSecret),
    connected: Boolean(t),
    athlete: t?.athlete ? [t.athlete.firstname, t.athlete.lastname].filter(Boolean).join(" ") : null,
    cells: grid.size,
    ...sync,
  };
}

/** Douglas-Peucker sencillo en metros (para aligerar las trazas que se envían al mapa). */
function simplify(pts: LngLat[], tolM: number): LngLat[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0, idx = -1;
    // distancia punto-segmento (funciona también en bucles, donde a y b coinciden)
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i], pts[a], pts[b]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolM && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Al arrancar, si ya hay datos, construir el mapa de calor
if (existsSync(ACTIVITIES)) buildGrid();
