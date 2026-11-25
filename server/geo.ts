import type { LngLat } from "../shared/types.ts";

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversine(a: LngLat | number[], b: LngLat | number[]): number {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function pointInPolygon(p: LngLat | number[], poly: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function closeRing(poly: LngLat[]): LngLat[] {
  const f = poly[0], l = poly[poly.length - 1];
  return f[0] === l[0] && f[1] === l[1] ? poly : [...poly, f];
}

export function centroid(pts: LngLat[]): LngLat {
  const n = pts.length;
  return [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n];
}

export function bbox(poly: LngLat[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

/** Convex hull (monotone chain) */
export function convexHull(points: LngLat[]): LngLat[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: LngLat, a: LngLat, b: LngLat) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: LngLat[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: LngLat[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Expande un polígono convexo `meters` hacia fuera desde su centroide (aproximación de buffer). */
export function expand(poly: LngLat[], meters: number): LngLat[] {
  const c = centroid(poly);
  return poly.map((p) => {
    const d = haversine(c, p) || 1;
    const k = (d + meters) / d;
    return [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k] as LngLat;
  });
}

/** Punto aleatorio dentro del polígono (muestreo por rechazo en su bbox). */
export function randomPointIn(poly: LngLat[], rand: () => number): LngLat | null {
  const b = bbox(poly);
  for (let i = 0; i < 500; i++) {
    const p: LngLat = [b.minX + rand() * (b.maxX - b.minX), b.minY + rand() * (b.maxY - b.minY)];
    if (pointInPolygon(p, poly)) return p;
  }
  return null;
}

/** Distancia (m) de un punto a una polilínea, aproximación equirectangular local. */
export function distToSegment(p: number[], a: number[], b: number[]): number {
  const kx = Math.cos(rad(p[1])) * 111320, ky = 110540;
  const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky;
  const bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

export function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function bearing(from: LngLat, to: LngLat): number {
  return Math.atan2(to[0] - from[0], to[1] - from[1]);
}
