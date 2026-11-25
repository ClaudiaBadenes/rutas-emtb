/**
 * Senderos de Trailforks en memoria (los carga tfsync.ts desde la caché del móvil) y utilidades
 * para el planificador: búsqueda cerca de una ruta, calidad, zonas (contornos) y trazados OSM.
 */
import type { LngLat, TfRegion, TfTrail } from "../../shared/types.ts";
import { convexHull, distToSegment, expand, haversine } from "./geo.ts";

export interface TrailGeometry { c: [number, number][]; conf: number; kind: "nombre" | "senda" | "acceso"; ride: "bajada" | "subida"; drop: number | null; osm: string[] }

export let trails: TfTrail[] = [];
/** Trazados aproximados desde OSM (fichero estático generado por scripts/build_trail_geometry.py) */
export let geometry: Record<string, TrailGeometry> = {};
export let regions: TfRegion[] = [];

const CELL = 0.01;
const grid = new Map<string, TfTrail[]>();
const key = (x: number, y: number) => `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;

export interface RegionMeta { region_id: number; title: string; url: string; total_trails: number; rating: number; latitude: number; longitude: number }

/** Sustituye los senderos en memoria (solo abiertos) y recalcula índices y contornos de zonas */
export function setTrails(list: TfTrail[], regionMeta: RegionMeta[], origin: LngLat) {
  trails = list.filter((t) => t.status !== 4 && t.latitude && t.longitude);
  grid.clear();
  for (const t of trails) {
    const k = key(t.longitude, t.latitude);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(t);
  }
  regions = regionMeta.map((r) => {
    const pts = trails.filter((x) => x.rid === r.region_id).map((x) => [x.longitude, x.latitude] as LngLat);
    const hull = pts.length >= 5 ? expand(convexHull(pts), 400) : null;
    return {
      region_id: r.region_id, title: r.title, url: r.url, total_trails: r.total_trails, rating: r.rating,
      distance_km: haversine(origin, [r.longitude, r.latitude]) / 1000, polygon: hull,
    };
  }).filter((r) => r.polygon);
}

export function setGeometry(g: Record<string, TrailGeometry>) {
  geometry = g;
}

/** Senderos cuyo punto de referencia está a menos de `maxM` metros de la ruta */
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
      if (Math.abs(a[1] - p[1]) > 0.003 && Math.abs(b[1] - p[1]) > 0.003) continue;
      if (distToSegment(p, a, b) <= maxM) { hits.push(t); break; }
    }
  }
  return hits;
}

/** Peso de calidad de un sendero: popularidad (checkins) + valoración */
export function trailQuality(t: TfTrail): number {
  const pop = Math.log1p(t.total_checkins ?? 0);
  const rating = (t.rating ?? 0) * Math.min(1, (t.votes ?? 0) / 3);
  return 1 + pop + rating * 0.6;
}

export function trailsInPolygon(poly: LngLat[], inside: (p: LngLat, poly: LngLat[]) => boolean): TfTrail[] {
  return trails.filter((t) => inside([t.longitude, t.latitude], poly));
}
