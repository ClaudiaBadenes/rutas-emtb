import type { Candidate, PlanRequest } from "../../shared/types.ts";
import { gpxFilename, toGpx } from "./gpx.ts";

const TYPE_LABEL = { mixta: "Mixta", xc: "XC", enduro: "Enduro", gravel: "Gravel" } as const;

export function routeTitle(req: PlanRequest, c: Candidate, label: string) {
  const kind = req.end ? "AB" : "circular";
  return `eMTB ${TYPE_LABEL[req.routeType]} ${kind} ${Math.round(c.stats.distanceKm)}km +${Math.round(c.stats.ascentM)}m (${label})`;
}

/**
 * Exporta el GPX: en el móvil abre el menú Compartir (Garmin Connect, Archivos, WhatsApp…);
 * en el ordenador lo descarga.
 */
export async function exportGpx(c: Candidate, name: string): Promise<"compartido" | "descargado" | "cancelado"> {
  const xml = toGpx(c, name);
  const file = new File([xml], gpxFilename(name), { type: "application/gpx+xml" });
  const mobile = /iPhone|iPad|Android/i.test(navigator.userAgent);
  if (mobile && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return "compartido";
    } catch (e) {
      if ((e as Error).name === "AbortError") return "cancelado";
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return "descargado";
}
