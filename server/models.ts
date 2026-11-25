import type { PlanRequest, RouteType, ZoneStrength } from "../shared/types.ts";
import { closeRing } from "./geo.ts";

type Rule = { if?: string; else_if?: string; else?: string; multiply_by?: string; limit_to?: string };

const OFFROAD = "(road_class == PATH || road_class == TRACK || road_class == BRIDLEWAY)";

/** Preferencias por tipo de ruta. Solo reducen prioridad (≤ 1), así son compatibles con LM. */
const ROUTE_TYPE_RULES: Record<RouteType, Rule[]> = {
  // Equilibrada: evita asfalto, sin más manías
  mixta: [{ if: `!${OFFROAD}`, multiply_by: "0.45" }],
  // XC: pista y senda fácil/media, poco técnico
  xc: [
    { if: `!${OFFROAD}`, multiply_by: "0.5" },
    { if: "mtb_rating > 3", multiply_by: "0.3" },
  ],
  // Enduro: subir por pista/asfalto, bajar por senda
  enduro: [
    { if: `!${OFFROAD}`, multiply_by: "0.6" },
    { if: "road_class == PATH && average_slope > 6", multiply_by: "0.35" },
    { if: "road_class == TRACK && average_slope < -5", multiply_by: "0.5" },
    { if: "road_class == TRACK && average_slope >= -2 && average_slope <= 2", multiply_by: "0.8" },
  ],
  // Gravel: pistas, nada de senda técnica
  gravel: [
    { if: "road_class == PATH || road_class == BRIDLEWAY", multiply_by: "0.25" },
    { if: "mtb_rating > 2", multiply_by: "0.1" },
    { if: "road_class == PRIMARY || road_class == SECONDARY", multiply_by: "0.5" },
  ],
};

const DISTANCE_INFLUENCE: Record<RouteType, number> = { mixta: 40, xc: 40, enduro: 25, gravel: 55 };

/** Cuánto se penaliza ir fuera de la zona preferida */
export const ZONE_OUTSIDE_FACTOR: Record<ZoneStrength, string> = { suave: "0.7", fuerte: "0.35", solo: "0.12" };

export function buildCustomModel(req: PlanRequest) {
  const priority: Rule[] = [...ROUTE_TYPE_RULES[req.routeType]];

  // Dificultad máxima: mtb_rating = mtb:scale + 1 (0 = sin dato)
  priority.push({ if: `mtb_rating > ${req.maxScale + 1}`, multiply_by: "0" });

  // Objetivo de dificultad de hoy
  if (req.difficultyTarget === "facil") {
    priority.push({ if: "mtb_rating > 2", multiply_by: "0.35" });
    priority.push({ if: "average_slope > 14", multiply_by: "0.6" });
  } else if (req.difficultyTarget === "dificil") {
    priority.push({ if: `!${OFFROAD}`, multiply_by: "0.75" });
    priority.push({ if: "road_class == TRACK", multiply_by: "0.85" });
  }

  const features: any[] = [];
  if (req.prefZone && req.prefZone.polygon.length >= 3) {
    features.push({ type: "Feature", id: "pref", properties: {}, geometry: { type: "Polygon", coordinates: [closeRing(req.prefZone.polygon)] } });
    priority.push({ if: "!in_pref", multiply_by: ZONE_OUTSIDE_FACTOR[req.prefZone.strength] });
  }
  req.avoidZones.forEach((poly, i) => {
    if (poly.length < 3) return;
    features.push({ type: "Feature", id: `avoid${i}`, properties: {}, geometry: { type: "Polygon", coordinates: [closeRing(poly)] } });
    priority.push({ if: `in_avoid${i}`, multiply_by: "0" });
  });

  const model: Record<string, unknown> = { priority, distance_influence: DISTANCE_INFLUENCE[req.routeType] };
  if (features.length) model.areas = { type: "FeatureCollection", features };
  return model;
}
