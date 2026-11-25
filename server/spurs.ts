/**
 * Detección de "callejones": tramos en los que la ruta entra por un camino y, poco después,
 * vuelve a salir por el mismo (ida y vuelta). Suelen aparecer cuando un punto de paso cae en
 * un sendero sin salida o al final de un ramal.
 */
import { haversine } from "./geo.ts";

export interface Spur {
  /** índice donde empieza la ida (el cruce) */
  base: number;
  /** índice aproximado del punto de giro */
  apex: number;
  /** índice donde termina la vuelta */
  end: number;
  /** longitud de la ida, en metros */
  lengthM: number;
  /**
   * "giro": entra en un ramal y da media vuelta (callejón sin salida).
   * "lazo": sale y vuelve por el mismo camino con un bucle en medio (palo de piruleta).
   */
  kind: "giro" | "lazo";
}

const TOL_M = 22;          // dos puntos a menos de esto se consideran el mismo sitio del camino
const MAX_LOOP_M = 9000;   // si vuelve a pasar más tarde que esto, no es un callejón sino otra cosa (p. ej. la aproximación)
const MIN_SPUR_M = 90;     // ramales más cortos se ignoran (ruido, rotondas, cruces en zig-zag)

export function findSpurs(c: number[][]): Spur[] {
  const n = c.length;
  if (n < 4) return [];
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + haversine(c[i - 1], c[i]));

  // Rejilla de ~25 m para buscar puntos cercanos
  const CELL_LAT = 0.00022, CELL_LON = 0.00029;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.floor(x / CELL_LON)}:${Math.floor(y / CELL_LAT)}`;
  // Densificamos virtualmente: para cada punto j buscamos el último i anterior cercano
  const match = new Int32Array(n).fill(-1);
  for (let j = 0; j < n; j++) {
    const cx = Math.floor(c[j][0] / CELL_LON), cy = Math.floor(c[j][1] / CELL_LAT);
    let best = -1;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const i of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
          const gap = cum[j] - cum[i];
          if (gap > 2 * TOL_M && gap < MAX_LOOP_M && i > best && haversine(c[i], c[j]) < TOL_M) best = i;
        }
    match[j] = best;
    const k = key(c[j][0], c[j][1]);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(j);
  }

  // Tramos de vuelta: puntos consecutivos que coinciden con puntos anteriores, en orden inverso
  const spurs: Spur[] = [];
  let j = 0;
  while (j < n) {
    if (match[j] < 0) { j++; continue; }
    let s = j, e = j;
    while (e + 1 < n && match[e + 1] >= 0 && match[e + 1] <= match[e] + 2) e++;
    const base = match[e];
    const oneWay = (cum[e] - cum[base]) / 2;
    if (oneWay >= MIN_SPUR_M && match[s] > base) {
      // Si la vuelta empieza justo donde acabó la ida, es un giro en redondo; si hay un bucle en medio, un lazo
      const turnGap = cum[s] - cum[match[s]];
      const kind = turnGap < 250 ? "giro" : "lazo";
      const lengthM = kind === "giro" ? oneWay : (cum[e] - cum[s]);
      spurs.push({ base, apex: Math.max(base, s - 1), end: e, lengthM, kind });
    }
    j = e + 1;
  }
  return spurs;
}

export const spurTotalM = (spurs: Spur[]) => spurs.reduce((s, x) => s + x.lengthM, 0);
