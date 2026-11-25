import type { Candidate } from "../../shared/types.ts";

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/**
 * GPX 1.1 con un único track y altitud: es el formato que Garmin Connect importa como
 * "Recorrido" (Course) y que los Edge / Fenix / Epix aceptan directamente por USB.
 * Se quitan puntos duplicados consecutivos (Garmin los rechaza en algunos modelos).
 */
export function toGpx(c: Candidate, name: string): string {
  const s = c.stats;
  const desc = `${s.distanceKm.toFixed(1)} km · +${Math.round(s.ascentM)} m · senda ${s.surface.senda.toFixed(1)} km, ` +
    `pista ${s.surface.pista.toFixed(1)} km, asfalto ${s.surface.asfalto.toFixed(1)} km` +
    (c.trailforks.length ? ` · senderos: ${c.trailforks.slice(0, 8).map((t) => t.title).join(", ")}` : "");
  const pts: string[] = [];
  let prev = "";
  for (const [lon, lat, ele] of c.coords) {
    const key = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    if (key === prev) continue;
    prev = key;
    pts.push(`      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><ele>${(ele ?? 0).toFixed(1)}</ele></trkpt>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Rutas eMTB" xmlns="http://www.topografix.com/GPX/1/1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${esc(name)}</name>
    <desc>${esc(desc)}</desc>
    <time>${new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>${esc(name)}</name>
    <desc>${esc(desc)}</desc>
    <type>cycling</type>
    <trkseg>
${pts.join("\n")}
    </trkseg>
  </trk>
</gpx>
`;
}

export function gpxFilename(name: string) {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w\-+]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") + ".gpx";
}
