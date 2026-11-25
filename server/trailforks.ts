import { readFileSync, existsSync } from "node:fs";
import type { LngLat, TfRegion, TfTrail } from "../shared/types.ts";
import { convexHull, distToSegment, expand } from "./geo.ts";

const TRAILS_FILE = new URL("../data/trailforks-trails.json", import.meta.url);
const REGIONS_FILE = new URL("../data/trailforks-regions.json", import.meta.url);
const GEOMETRY_FILE = new URL("../data/trail-geometry.json", import.meta.url);

/** Trazados aproximados desde OSM (scripts/build_trail_geometry.py) */
export let geometry: Record<string, { c: [number, number][]; conf: number; kind: "nombre" | "senda" | "acceso"; ride: "bajada" | "subida"; drop: number | null; osm: string[] }> = {};

export let trails: TfTrail[] = [];
export let regions: TfRegion[] = [];
export let meta: Record<string, unknown> | null = null;

// Rejilla espacial (~1 km) para buscar senderos cerca de una ruta rápidamente
const CELL = 0.01;
const grid = new Map<string, TfTrail[]>();
const key = (x: number, y: number) => `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;

export function loadTrailforks() {
  if (!existsSync(TRAILS_FILE)) {
    console.warn("[trailforks] No hay datos. Ejecuta: npm run sync:trailforks");
    return;
  }
  const t = JSON.parse(readFileSync(TRAILS_FILE, "utf8"));
  meta = t.meta;
  // Solo senderos abiertos (status 4 = cerrado)
  trails = (t.trails as TfTrail[]).filter((x) => x.status !== 4 && x.latitude && x.longitude);
  grid.clear();
  for (const tr of trails) {
    const k = key(tr.longitude, tr.latitude);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(tr);
  }

  if (existsSync(REGIONS_FILE)) {
    const r = JSON.parse(readFileSync(REGIONS_FILE, "utf8"));
    regions = (r.regions as any[]).map((reg) => {
      const pts = trails.filter((x) => x.rid === reg.region_id).map((x) => [x.longitude, x.latitude] as LngLat);
      const hull = pts.length >= 5 ? expand(convexHull(pts), 400) : null;
      return {
        region_id: reg.region_id, title: reg.title, url: reg.url, total_trails: reg.total_trails,
        rating: reg.rating, distance_km: reg.distance_km, polygon: hull,
      };
    }).filter((r) => r.polygon);
  }
  if (existsSync(GEOMETRY_FILE)) geometry = JSON.parse(readFileSync(GEOMETRY_FILE, "utf8")).trails ?? {};
  console.log(`[trailforks] ${trails.length} senderos, ${regions.length} zonas con contorno, ${Object.keys(geometry).length} trazados aproximados`);
}

/** Senderos de Trailforks cuyo punto de referencia está a menos de `maxM` metros de la ruta. */
export function trailsAlong(coords: number[][], maxM = 60): TfTrail[] {
  const candidates = new Set<TfTrail>();
  for (let i = 0; i < coords.length; i += 3) {
    const [x, y] = coords[i];
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) grid.get(`${cx + dx}:${cy + dy}`)?.forEach((t) => candidates.add(t));
  }
  const hits: TfTrail[] = [];
  for (const t of candidates) {
    const p = [t.longitude, t.latitude];
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1], b = coords[i];
      // descarte rápido por caja
      if (Math.abs(a[1] - p[1]) > 0.003 && Math.abs(b[1] - p[1]) > 0.003) continue;
      if (distToSegment(p, a, b) <= maxM) { hits.push(t); break; }
    }
  }
  return hits;
}

/** Peso de calidad de un sendero: popularidad (checkins) + valoración. */
export function trailQuality(t: TfTrail): number {
  const pop = Math.log1p(t.total_checkins ?? 0);           // 0..~8
  const rating = (t.rating ?? 0) * Math.min(1, (t.votes ?? 0) / 3); // 0..5
  return 1 + pop + rating * 0.6;
}

export function trailsInPolygon(poly: LngLat[], inside: (p: LngLat, poly: LngLat[]) => boolean): TfTrail[] {
  return trails.filter((t) => inside([t.longitude, t.latitude], poly));
}
