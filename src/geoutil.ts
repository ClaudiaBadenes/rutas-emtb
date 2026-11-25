import type { LngLat } from "../shared/types.ts";

export function pointInPolygon(p: number[], poly: LngLat[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distancia aproximada en metros (equirectangular, suficiente para distancias cortas) */
export function approxDist(a: number[], b: number[]): number {
  const kx = 111320 * Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110540);
}

/** Índice del punto de la ruta más cercano a p, buscando a partir de `from` */
export function nearestIndex(coords: number[][], p: number[], from = 0): number {
  let best = Infinity, idx = from;
  for (let i = from; i < coords.length; i++) {
    const d = approxDist(coords[i], p);
    if (d < best) { best = d; idx = i; }
  }
  return idx;
}

/**
 * Posición en la lista de puntos de paso donde insertar uno nuevo que se arrastró
 * desde el punto `grab` de la ruta: cuenta los pasos que la ruta recorre antes de ese punto.
 */
export function insertPosition(coords: number[][], via: LngLat[], grab: LngLat): number {
  const g = nearestIndex(coords, grab);
  let from = 0, pos = 0;
  for (const v of via) {
    const i = nearestIndex(coords, v, from);
    if (i < g) { pos++; from = i; } else break;
  }
  return pos;
}

/** Posición actual del usuario (requiere permiso del navegador) */
export function myLocation(): Promise<LngLat> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("Este navegador no permite obtener tu ubicación."));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve([pos.coords.longitude, pos.coords.latitude]),
      (err) => reject(new Error(err.code === err.PERMISSION_DENIED
        ? "No hay permiso para usar tu ubicación. Actívalo para esta web en el navegador."
        : "No se pudo obtener tu ubicación.")),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });
}
