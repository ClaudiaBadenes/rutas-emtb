/**
 * Senderos de Trailforks bajo demanda, desde el propio móvil.
 *
 * El área que hace falta (salida + radio según la distancia) se divide en cuadrículas de ~4 km.
 * Las que no están en la caché (o tienen más de 14 días) se descargan del MCP público de Trailforks,
 * respetando su límite (60 consultas/minuto por dispositivo), y se guardan en IndexedDB.
 * La primera vez se carga una semilla con los senderos de alrededor de Petrés.
 */
import type { LngLat, TfTrail } from "../../shared/types.ts";
import * as db from "./db.ts";
import { haversine } from "./geo.ts";
import { setGeometry, setTrails, type RegionMeta } from "./trails.ts";

const MCP = "https://www.trailforks.com/mcp/";
const TILE = 0.04;                  // grados (~4,4 km N-S, ~3,4 km E-O a 39,7°N)
const TILE_TTL = 14 * 86400e3;      // 14 días
const REGION_TTL = 30 * 86400e3;
const MIN_INTERVAL_MS = 1100;       // < 60 consultas por minuto
const MAX_ROWS = 50;

export interface SyncProgress { phase: "senderos" | "popularidad" | "listo"; done: number; total: number; calls: number }

const KEEP: (keyof TfTrail | "trailtype")[] = ["trailid", "title", "url", "rid", "region_title", "difficulty", "difficulty_label", "latitude", "longitude",
  "distance_m", "alt_climb_m", "rating", "votes", "direction", "status", "unsanctioned", "biketype", "trailtype", "global_rank", "total_checkins"];
const trim = (t: any): TfTrail => Object.fromEntries(KEEP.filter((k) => t[k] !== undefined).map((k) => [k, t[k]])) as TfTrail;

let last = 0;
let calls = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mcp(name: string, args: Record<string, unknown>): Promise<any> {
  const wait = last + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now();
  calls++;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(MCP, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: calls, method: "tools/call", params: { name, arguments: args } }),
    }).catch(() => null);
    if (res?.status === 429) { await sleep(15000); continue; }
    if (!res?.ok) { await sleep(2000 * (attempt + 1)); continue; }
    const json = await res.json();
    if (json.error) throw new Error(JSON.stringify(json.error));
    return json.result?.structuredContent ?? {};
  }
  throw new Error("Trailforks no responde. Comprueba la conexión e inténtalo de nuevo.");
}

const tileId = (ix: number, iy: number) => `${ix}_${iy}`;
const tileBox = (ix: number, iy: number) => ({ minLon: ix * TILE, minLat: iy * TILE, maxLon: (ix + 1) * TILE, maxLat: (iy + 1) * TILE });

/** Cuadrículas que tocan el círculo (centro, radio) */
export function tilesFor(center: LngLat, radiusKm: number): [number, number][] {
  const dLat = radiusKm / 111.32, dLon = radiusKm / (111.32 * Math.cos((center[1] * Math.PI) / 180));
  const out: [number, number][] = [];
  for (let ix = Math.floor((center[0] - dLon) / TILE); ix <= Math.floor((center[0] + dLon) / TILE); ix++)
    for (let iy = Math.floor((center[1] - dLat) / TILE); iy <= Math.floor((center[1] + dLat) / TILE); iy++) {
      const b = tileBox(ix, iy);
      const nearest: LngLat = [Math.max(b.minLon, Math.min(center[0], b.maxLon)), Math.max(b.minLat, Math.min(center[1], b.maxLat))];
      if (haversine(center, nearest) <= radiusKm * 1000) out.push([ix, iy]);
    }
  return out;
}

async function fetchBox(b: ReturnType<typeof tileBox>, depth = 0): Promise<TfTrail[]> {
  const r = await mcp("search_trails_within_bounds", {
    min_latitude: b.minLat, max_latitude: b.maxLat, min_longitude: b.minLon, max_longitude: b.maxLon, rows: MAX_ROWS,
  });
  const list: TfTrail[] = (r.trails ?? []).map(trim);
  if (list.length < MAX_ROWS || depth >= 4) return list;
  // Cuadrícula saturada (máx. 50 por consulta): se divide en cuatro
  const mLat = (b.minLat + b.maxLat) / 2, mLon = (b.minLon + b.maxLon) / 2;
  const parts = [
    { minLat: b.minLat, maxLat: mLat, minLon: b.minLon, maxLon: mLon }, { minLat: b.minLat, maxLat: mLat, minLon: mLon, maxLon: b.maxLon },
    { minLat: mLat, maxLat: b.maxLat, minLon: b.minLon, maxLon: mLon }, { minLat: mLat, maxLat: b.maxLat, minLon: mLon, maxLon: b.maxLon },
  ];
  const out: TfTrail[] = [];
  for (const p of parts) out.push(...(await fetchBox(p, depth + 1)));
  return out;
}

// ── Semilla y carga en memoria ──────────────────────────────────────────────────────────────

let seeded: Promise<void> | null = null;

/** Primera vez: senderos de alrededor de Petrés y trazados OSM (ficheros estáticos de la app) */
export function loadSeed(): Promise<void> {
  if (seeded) return seeded;
  seeded = (async () => {
    const geo = await fetch(`${import.meta.env.BASE_URL}data/trail-geometry.json`).then((r) => r.json()).catch(() => null);
    if (geo?.trails) setGeometry(geo.trails);
    if (await db.get("meta", "seed")) return;
    const seed = await fetch(`${import.meta.env.BASE_URL}data/seed-trails.json`).then((r) => r.json()).catch(() => null);
    if (!seed) return;
    await db.putMany("trails", seed.trails.map((t: TfTrail) => [t.trailid, t]));
    await db.putMany("regions", seed.regions.map((r: RegionMeta) => [r.region_id, { ...r, popAt: seed.fetchedAt }]));
    await db.putMany("tiles", seed.tiles.map((id: string) => [id, { at: seed.fetchedAt }]));
    await db.put("meta", "seed", { at: seed.fetchedAt, version: 1 });
  })();
  return seeded;
}

/** Vuelca a memoria todos los senderos y zonas de la caché */
export async function loadCache(origin: LngLat) {
  await loadSeed();
  const [list, regions] = await Promise.all([db.getAll<TfTrail>("trails"), db.getAll<RegionMeta>("regions")]);
  setTrails(list, regions, origin);
  return list.length;
}

/** Radio que cubre una ruta: circular hasta ~D/2 en línea recta; A→B, el tramo entre ambos */
export function radiusFor(start: LngLat, end: LngLat | null, targetKm: number): { center: LngLat; radiusKm: number } {
  if (!end) return { center: start, radiusKm: Math.min(60, targetKm / 2 + 3) };
  const center: LngLat = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
  return { center, radiusKm: Math.min(60, haversine(start, end) / 2000 + Math.max(5, targetKm / 6)) };
}

/** Cuántas cuadrículas faltan por descargar para esta zona (para avisar antes) */
export async function missingTiles(center: LngLat, radiusKm: number) {
  const now = Date.now();
  const tiles = tilesFor(center, radiusKm);
  const status = await Promise.all(tiles.map(([ix, iy]) => db.get<{ at: number }>("tiles", tileId(ix, iy))));
  return tiles.filter((_, i) => !status[i] || now - status[i]!.at > TILE_TTL);
}

let running: Promise<number> | null = null;

/** Descarga lo que falte para (centro, radio) y recarga la memoria. Devuelve nº de senderos. */
export function ensureArea(center: LngLat, radiusKm: number, onProgress?: (p: SyncProgress) => void): Promise<number> {
  const job = (running ?? Promise.resolve(0)).catch(() => 0).then(async () => {
    await loadSeed();
    const missing = await missingTiles(center, radiusKm);
    const startCalls = calls;
    for (let i = 0; i < missing.length; i++) {
      onProgress?.({ phase: "senderos", done: i, total: missing.length, calls: calls - startCalls });
      const [ix, iy] = missing[i];
      const list = await fetchBox(tileBox(ix, iy));
      const existing = await Promise.all(list.map((t) => db.get<TfTrail>("trails", t.trailid)));
      // conservar la popularidad ya conocida
      await db.putMany("trails", list.map((t, k) => [t.trailid, { ...existing[k], ...t, total_checkins: existing[k]?.total_checkins ?? t.total_checkins, global_rank: existing[k]?.global_rank ?? t.global_rank }]));
      await db.put("tiles", tileId(ix, iy), { at: Date.now() });
    }
    // Popularidad: los 50 senderos más usados de cada zona (una consulta por zona, cada 30 días)
    if (missing.length) {
      const r = await mcp("search_regions_near_location", { latitude: center[1], longitude: center[0], radius_km: radiusKm, rows: 60 });
      const areas = (r.regions ?? []).filter((x: any) => x.is_riding_area);
      const now = Date.now();
      const todo: any[] = [];
      for (const a of areas) {
        const known = await db.get<RegionMeta & { popAt?: number }>("regions", a.region_id);
        if (!known?.popAt || now - known.popAt > REGION_TTL) todo.push(a);
      }
      for (let i = 0; i < todo.length; i++) {
        onProgress?.({ phase: "popularidad", done: i, total: todo.length, calls: calls - startCalls });
        const a = todo[i];
        const pop = await mcp("popular_trails_in_area", { region_id: a.region_id, rows: 50 });
        const upd: [number, TfTrail][] = [];
        for (const p of pop.trails ?? []) {
          const t = await db.get<TfTrail>("trails", p.trailid);
          if (t) upd.push([p.trailid, { ...t, total_checkins: p.total_checkins, global_rank: p.global_rank }]);
        }
        await db.putMany("trails", upd);
        await db.put("regions", a.region_id, {
          region_id: a.region_id, title: a.title, url: a.url, total_trails: a.total_trails, rating: a.rating,
          latitude: a.latitude, longitude: a.longitude, popAt: Date.now(),
        });
      }
    }
    onProgress?.({ phase: "listo", done: 1, total: 1, calls: calls - startCalls });
    return loadCache(center);
  });
  running = job;
  return job;
}
