/**
 * Motor de rutas BRouter, llamado directamente desde el navegador.
 *
 * - Producción: https://brouter.de/brouter (servidor comunitario, gratuito, uso moderado).
 * - Desarrollo: servidor BRouter local (npm run brouter) a través del proxy de Vite (/brouter).
 *
 * El perfil eMTB se genera a partir de los perfiles mtb / gravel de BRouter (incluidos en la app)
 * y se sube al servidor (POST /profile). Los perfiles subidos son temporales: si el servidor ya no
 * lo tiene, se vuelve a subir automáticamente.
 */
import type { LngLat, PlanRequest } from "../../shared/types.ts";
import mtbBase from "./profiles/mtb.brf?raw";
import gravelBase from "./profiles/gravel.brf?raw";

export const BROUTER_URL: string = import.meta.env.VITE_BROUTER_URL ?? "https://brouter.de/brouter";

export interface EnginePath {
  distance: number;
  time: number;
  ascend: number;
  descend: number;
  points: { coordinates: [number, number, number][] };
  details: Record<string, [number, number, string | number][]>;
}

// ── Perfiles eMTB ───────────────────────────────────────────────────────────────────────────

const MTB_FACTOR = { mixta: 0.5, xc: 0.3, enduro: 1.0, gravel: 0 } as const;
const TARGET_SHIFT = { facil: -0.3, media: 0, dificil: 0.5 } as const;
const SCALE_LABELS = ["0-", "0", "0+", "1-", "1", "1+", "2-", "2", "2+", "3", "4|5|6"];
const SCALE_VALUE: Record<string, number> = { "0-": 0, "0": 0, "0+": 0, "1-": 1, "1": 1, "1+": 1, "2-": 2, "2": 2, "2+": 2, "3": 3, "4|5|6": 4 };
const SCALE_PENALTY: Record<string, number> = { "0-": 0, "0": 0, "0+": 0.3, "1-": 0.7, "1": 1.2, "1+": 1.8, "2-": 2.5, "2": 5, "2+": 10, "3": 15, "4|5|6": 30 };

const profileKey = (req: PlanRequest) => `emtb_${req.routeType}_${req.difficultyTarget}_s${req.maxScale}`;

export function profileText(req: PlanRequest): string {
  if (req.routeType === "gravel") {
    // Gravel: perfil "gravel" de BRouter con masa y potencia de una e-bike
    return gravelBase
      .replace(/assign totalMass\s*=\s*\d+/, "assign totalMass  = 115")
      .replace(/assign bikerPower\s*=\s*\d+/, `assign bikerPower = ${req.difficultyTarget === "facil" ? 300 : 380}`)
      .replace(/assign prefer_unpaved_paths false/, "assign prefer_unpaved_paths true")
      .replace(/assign consider_elevation false/, "assign consider_elevation true");
  }
  const mtbFactor = Math.max(-3, Math.min(3, MTB_FACTOR[req.routeType] + TARGET_SHIFT[req.difficultyTarget]));
  const scaleBlock = SCALE_LABELS.map((l) => `if mtb:scale=${l} then ${SCALE_VALUE[l] > req.maxScale ? 9000 : SCALE_PENALTY[l]} else`).join("\n  ");
  return mtbBase
    .replace(/assign\s+MTB_factor\s+[-\d.]+/, `assign   MTB_factor             ${mtbFactor}`)
    // eMTB: el motor hace la subida; solo en "tranquila" se penalizan las rampas
    .replace(/assign\s+hills\s+\d+/, `assign   hills                  ${req.difficultyTarget === "facil" ? 1 : 0}`)
    // BRouter elimina por sí mismo idas y vueltas cortas en los puntos de paso
    .replace(/assign correctMisplacedViaPoints = false/, "assign correctMisplacedViaPoints = true")
    .replace(/assign correctMisplacedViaPointsDistance = \d+/, "assign correctMisplacedViaPointsDistance = 600")
    // Dificultad máxima: por encima de S-max, prohibido (9000)
    .replace(/if mtb:scale=\s+then 0\.0 else[\s\S]*?if mtb:scale=4\|5\|6\s+then 9000\s+else 0\.0/, `if mtb:scale= then 0.0 else\n  ${scaleBlock} 0.0`);
}

const uploaded = new Map<string, Promise<string>>();

function ensureProfile(req: PlanRequest, force = false): Promise<string> {
  const key = profileKey(req);
  if (!force && uploaded.has(key)) return uploaded.get(key)!;
  const p = (async () => {
    const res = await fetch(`${BROUTER_URL}/profile`, { method: "POST", body: profileText(req) });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json.profileid) throw new Error(`El servidor de rutas no aceptó el perfil: ${json.error ?? res.status}`);
    return json.profileid as string;
  })();
  uploaded.set(key, p);
  p.catch(() => uploaded.delete(key));
  return p;
}

// ── Petición y conversión ───────────────────────────────────────────────────────────────

const roadClass = (wayTags: string) => (/highway=(\S+)/.exec(wayTags)?.[1] ?? "unknown").toUpperCase();
const mtbRating = (wayTags: string) => { const s = /mtb:scale=(\d)/.exec(wayTags)?.[1]; return s === undefined ? 0 : Number(s) + 1; };

async function request(points: LngLat[], req: PlanRequest, alternative: number, profile: string) {
  const p = new URLSearchParams({
    lonlats: points.map(([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`).join("|"),
    profile,
    alternativeidx: String(alternative),
    format: "geojson",
  });
  const polys = req.avoidZones.filter((z) => z.length >= 3).map((z) => z.map(([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`).join(","));
  if (polys.length) p.set("polygons", polys.join("|"));
  const res = await fetch(`${BROUTER_URL}?${p}`);
  return { ok: res.ok, text: await res.text() };
}

export async function brouterRoute(points: LngLat[], req: PlanRequest, alternative = 0): Promise<EnginePath> {
  let r = await request(points, req, alternative, await ensureProfile(req));
  // Perfil caducado en el servidor: se vuelve a subir y se repite una vez
  if (!r.text.startsWith("{") && /profile/i.test(r.text)) r = await request(points, req, alternative, await ensureProfile(req, true));
  if (!r.ok || !r.text.startsWith("{")) throw new Error(`No se pudo calcular la ruta: ${r.text.slice(0, 160)}`);

  const f = JSON.parse(r.text).features[0];
  const coords = f.geometry.coordinates as [number, number, number][];
  const props = f.properties;

  // "messages": cada fila describe el tramo que TERMINA en su punto (lon/lat en millonésimas)
  const msgs: string[][] = props.messages.slice(1);
  const roadDetails: [number, number, string][] = [];
  const mtbDetails: [number, number, number][] = [];
  let ci = 0, from = 0;
  for (const m of msgs) {
    const lon = Number(m[0]) / 1e6, lat = Number(m[1]) / 1e6;
    let k = ci;
    while (k < coords.length - 1 && !(Math.abs(coords[k][0] - lon) < 2e-6 && Math.abs(coords[k][1] - lat) < 2e-6)) k++;
    if (k > from) {
      roadDetails.push([from, k, roadClass(m[9])]);
      mtbDetails.push([from, k, mtbRating(m[9])]);
    }
    from = k; ci = k;
  }
  if (from < coords.length - 1 && msgs.length) {
    const last = msgs[msgs.length - 1][9];
    roadDetails.push([from, coords.length - 1, roadClass(last)]);
    mtbDetails.push([from, coords.length - 1, mtbRating(last)]);
  }
  let descend = 0;
  for (let i = 1; i < coords.length; i++) descend += Math.max(0, (coords[i - 1][2] ?? 0) - (coords[i][2] ?? 0));
  return {
    distance: Number(props["track-length"]),
    // BRouter calcula el tiempo para un ciclista sin motor: con e-MTB ~1,5x más rápido
    time: (Number(props["total-time"]) / 1.5) * 1000,
    ascend: Number(props["filtered ascend"]),
    descend,
    points: { coordinates: coords },
    details: { road_class: roadDetails, mtb_rating: mtbDetails },
  };
}
