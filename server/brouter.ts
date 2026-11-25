/**
 * Motor de rutas BRouter (alternativa gratuita a GraphHopper).
 *
 * - Local: servidor BRouter en BROUTER_URL (por defecto http://localhost:17777/brouter),
 *   los perfiles se escriben en brouter/profiles.
 * - Remoto (brouter.de): los perfiles se suben con POST /brouter/profile y se usa el id devuelto.
 *
 * Devuelve la ruta con la misma forma que GraphHopper (GhPath) para que el resto del planificador
 * (estadísticas, callejones, senderos, GPX) funcione igual.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LngLat, PlanRequest } from "../shared/types.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROFILE_DIR = `${ROOT}brouter/profiles`;
export const BROUTER_URL = process.env.BROUTER_URL ?? "http://localhost:17777/brouter";
const isLocal = () => /localhost|127\.0\.0\.1/.test(BROUTER_URL);

export interface EnginePath {
  distance: number;
  time: number;
  ascend: number;
  descend: number;
  points: { coordinates: [number, number, number][] };
  details: Record<string, [number, number, string | number][]>;
}

// ── Perfiles eMTB generados a partir de los perfiles mtb / gravel de BRouter ────────────────

const MTB_FACTOR = { mixta: 0.5, xc: 0.3, enduro: 1.0, gravel: 0 } as const;
const TARGET_SHIFT = { facil: -0.3, media: 0, dificil: 0.5 } as const;
const SCALE_LABELS = ["0-", "0", "0+", "1-", "1", "1+", "2-", "2", "2+", "3", "4|5|6"];
const SCALE_VALUE: Record<string, number> = { "0-": 0, "0": 0, "0+": 0, "1-": 1, "1": 1, "1+": 1, "2-": 2, "2": 2, "2+": 2, "3": 3, "4|5|6": 4 };
const SCALE_PENALTY: Record<string, number> = { "0-": 0, "0": 0, "0+": 0.3, "1-": 0.7, "1": 1.2, "1+": 1.8, "2-": 2.5, "2": 5, "2+": 10, "3": 15, "4|5|6": 30 };

function profileName(req: PlanRequest) {
  return `emtb_${req.routeType}_${req.difficultyTarget}_s${req.maxScale}`;
}

function profileText(req: PlanRequest): string {
  const base = `${ROOT}brouter/profiles/${req.routeType === "gravel" ? "gravel" : "mtb"}.brf`;
  let t = readFileSync(base, "utf8");
  if (req.routeType === "gravel") {
    // Gravel: perfil "gravel" de BRouter con masa y potencia de una e-bike
    return t
      .replace(/assign totalMass\s*=\s*\d+/, "assign totalMass  = 115")
      .replace(/assign bikerPower\s*=\s*\d+/, `assign bikerPower = ${req.difficultyTarget === "facil" ? 300 : 380}`)
      .replace(/assign prefer_unpaved_paths false/, "assign prefer_unpaved_paths true")
      .replace(/assign consider_elevation false/, "assign consider_elevation true");
  }
  const mtbFactor = Math.max(-3, Math.min(3, MTB_FACTOR[req.routeType] + TARGET_SHIFT[req.difficultyTarget]));
  t = t.replace(/assign\s+MTB_factor\s+[-\d.]+/, `assign   MTB_factor             ${mtbFactor}`)
    // eMTB: el motor hace la subida; solo en "tranquila" se penalizan las rampas
    .replace(/assign\s+hills\s+\d+/, `assign   hills                  ${req.difficultyTarget === "facil" ? 1 : 0}`)
    .replace(/assign correctMisplacedViaPoints = false/, "assign correctMisplacedViaPoints = true")
    .replace(/assign correctMisplacedViaPointsDistance = \d+/, "assign correctMisplacedViaPointsDistance = 600");
  // Dificultad máxima: por encima de S-max, prohibido (9000); por debajo, la penalización original
  const scaleBlock = SCALE_LABELS.map((l) => `if mtb:scale=${l} then ${SCALE_VALUE[l] > req.maxScale ? 9000 : SCALE_PENALTY[l]} else`).join("\n  ");
  t = t.replace(/if mtb:scale=\s+then 0\.0 else[\s\S]*?if mtb:scale=4\|5\|6\s+then 9000\s+else 0\.0/, `if mtb:scale= then 0.0 else\n  ${scaleBlock} 0.0`);
  return t;
}

const remoteIds = new Map<string, string>();

async function ensureProfile(req: PlanRequest): Promise<string> {
  const name = profileName(req);
  if (isLocal()) {
    const file = `${PROFILE_DIR}/${name}.brf`;
    if (!existsSync(file)) writeFileSync(file, profileText(req));
    return name;
  }
  if (remoteIds.has(name)) return remoteIds.get(name)!;
  const res = await fetch(`${BROUTER_URL}/profile`, { method: "POST", body: profileText(req) });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.profileid) throw new Error(`BRouter no aceptó el perfil: ${json.error ?? res.status}`);
  remoteIds.set(name, json.profileid);
  return json.profileid;
}

// ── Petición y conversión ───────────────────────────────────────────────────────────────

function roadClass(wayTags: string): string {
  const hw = /highway=(\S+)/.exec(wayTags)?.[1] ?? "unknown";
  return hw.toUpperCase();
}
function mtbRating(wayTags: string): number {
  const s = /mtb:scale=(\d)/.exec(wayTags)?.[1];
  return s === undefined ? 0 : Number(s) + 1;
}

export async function brouterRoute(points: LngLat[], req: PlanRequest, alternative = 0): Promise<EnginePath> {
  const profile = await ensureProfile(req);
  const p = new URLSearchParams({
    lonlats: points.map(([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`).join("|"),
    profile,
    alternativeidx: String(alternative),
    format: "geojson",
  });
  // Zonas a evitar como polígonos prohibidos
  const polys = req.avoidZones.filter((z) => z.length >= 3).map((z) => z.map(([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`).join(","));
  if (polys.length) p.set("polygons", polys.join("|"));

  const res = await fetch(`${BROUTER_URL}?${p}`);
  const text = await res.text();
  if (!res.ok || !text.startsWith("{")) throw new Error(`BRouter: ${text.slice(0, 200)}`);
  const f = JSON.parse(text).features[0];
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
    if (k >= coords.length) break;
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
    // BRouter calcula el tiempo con un ciclista sin motor: lo ajustamos a una e-MTB (~1,5x más rápida)
    time: (Number(props["total-time"]) / 1.5) * 1000,
    ascend: Number(props["filtered ascend"]),
    descend,
    points: { coordinates: coords },
    details: { road_class: roadDetails, mtb_rating: mtbDetails },
  };
}
