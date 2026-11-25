import type { SurfaceKind } from "../shared/types.ts";

/** Mismos colores en la barra, el mapa y el perfil */
export const SURFACE_COLORS: Record<SurfaceKind, string> = {
  senda: "#8c5a2b",
  pista: "#d9a441",
  asfalto: "#868e96",
};

export const SURFACE_LABEL: Record<SurfaceKind, string> = { senda: "Senda", pista: "Pista", asfalto: "Asfalto" };

/** Colores oficiales de dificultad de Trailforks (por id) */
export const DIFFICULTY_COLORS: Record<number, string> = {
  1: "#854e85", 2: "#ffffff", 3: "#46b414", 4: "#148cf0", 5: "#111111",
  6: "#be0014", 7: "#ae83ae", 8: "#ff8500", 10: "#111111", 11: "#0b4b81",
};

export const HIGHLIGHT = "#f59f00";
