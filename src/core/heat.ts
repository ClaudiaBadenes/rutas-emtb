/**
 * Mapa de calor personal de Strava (por dónde ya has pasado).
 *
 * En la versión PWA, la conexión con Strava se hará con una función de Cloudflare (intercambio del
 * token con la clave secreta) y el mapa de calor se calculará y guardará en el móvil.
 * Mientras tanto no hay datos: el control de novedad queda desactivado.
 */
const grid = new Map<string, number>();
const CELL_LAT = 0.0002, CELL_LON = 0.00026;
const cellOf = (x: number, y: number) => [Math.floor(x / CELL_LON), Math.floor(y / CELL_LAT)] as const;

export const hasStravaData = () => grid.size > 0;

export function visitCount(x: number, y: number): number {
  const [cx, cy] = cellOf(x, y);
  let best = 0;
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) best = Math.max(best, grid.get(`${cx + dx}:${cy + dy}`) ?? 0);
  return best;
}

export function routeKnowledge(_coords: number[][]): { knownM: number; favM: number; totalM: number; ranges: [number, number][] } {
  return { knownM: 0, favM: 0, totalM: 1, ranges: [] };
}
