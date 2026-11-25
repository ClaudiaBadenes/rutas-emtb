export type LngLat = [number, number];

export type RouteType = "mixta" | "xc" | "enduro" | "gravel";
export type ZoneStrength = "suave" | "fuerte" | "solo";
export type AssistMode = "eco" | "tour" | "emtb" | "turbo";

export interface PlanRequest {
  start: LngLat;
  /** null = ruta circular */
  end: LngLat | null;
  waypoints: LngLat[];
  routeType: RouteType;
  targetKm: number;
  /** dificultad máxima en escala mtb:scale (0 = S0 … 5 = S5) */
  maxScale: number;
  prefZone: { polygon: LngLat[]; strength: ZoneStrength } | null;
  avoidZones: LngLat[][];
  battery: { wh: number; mode: AssistMode };
  /**
   * Control de novedad (requiere Strava): -1 = "lo mejor de la zona" (calidad Trailforks y tus
   * favoritos, aunque ya los conozcas) · 0 = equilibrado · +1 = "terreno nuevo para mí".
   */
  novelty: number;
  /** qué tipo de ruta busco hoy (además de la dificultad máxima) */
  difficultyTarget: DifficultyTarget;
  /** senderos de Trailforks que quiero hacer sí o sí (se usan como puntos de paso) */
  mustTrails: { id: number; point: LngLat }[];
  /** motor de rutas (por defecto el del servidor: GraphHopper) */
  engine?: "graphhopper" | "brouter";
}

export type DifficultyTarget = "facil" | "media" | "dificil";

/** Recalcular una ruta con puntos de paso fijos (modo Personalizar) */
export interface RouteRequest {
  req: PlanRequest;
  via: LngLat[];
}

export type SurfaceKind = "senda" | "pista" | "asfalto";
/** [índice inicial, índice final, tipo] sobre las coordenadas de la ruta */
export type SurfaceSegment = [number, number, SurfaceKind];

export interface TrailRef {
  id: number;
  title: string;
  url: string;
  difficulty: string;
  difficultyId: number;
  region: string;
  checkins?: number;
  rating?: number;
  lengthM?: number;
  /** popularidad + valoración (para ordenar) */
  importance: number;
  /** veces que has pasado según Strava (0 = nuevo) */
  ridden?: number;
  /** índice de la ruta más cercano al punto del sendero */
  at: number;
  /** tramo aproximado de la ruta que corresponde al sendero */
  range: [number, number];
}

export interface CandidateStats {
  distanceKm: number;
  ascentM: number;
  descentM: number;
  timeMin: number;
  /** km por tipo de vía */
  surface: { senda: number; pista: number; asfalto: number };
  /** km con dificultad técnica S2 o superior según OSM */
  technicalKm: number;
  batteryWh: number;
  batteryLeftPct: number;
  /** % de la ruta dentro de la zona preferida (null si no hay zona) */
  insideZonePct: number | null;
  /** % de la ruta que repite tramos ya recorridos en la misma ruta */
  overlapPct: number;
  trailforksCount: number;
  /** % de la ruta por donde nunca has pasado según Strava (null si no hay datos de Strava) */
  newPct: number | null;
  newKm: number | null;
  /** tramos de ida y vuelta por un ramal sin salida (rangos de índices + longitud de la ida) */
  deadEnds: { from: number; to: number; lengthM: number }[];
}

export interface ChosenTrail {
  id: number;
  title: string;
  /** true si tiene trazado (se intenta recorrer entero); false si solo hay punto */
  whole: boolean;
  /** fracción del trazado recorrida (0-1), null si no hay trazado */
  coverage: number | null;
  /** true si se recorre en el sentido previsto (bajada), null si no se puede saber */
  rightWay: boolean | null;
  /** la ruta pasa por el sendero (o por su punto) */
  passes: boolean;
  ride?: "bajada" | "subida";
}

export interface Candidate {
  id: string;
  /** [lon, lat, ele] */
  coords: [number, number, number][];
  stats: CandidateStats;
  score: number;
  scoreParts: Record<string, number>;
  trailforks: TrailRef[];
  surfaceSegments: SurfaceSegment[];
  via: LngLat[];
  /** tramos ya recorridos (rangos de índices de coords) */
  knownRanges: [number, number][];
  /** senderos que elegiste: cuánto los recorre la ruta y en qué sentido */
  chosen: ChosenTrail[];
}

export interface PlanResponse {
  candidates: Candidate[];
  warnings: string[];
}

export interface TfTrail {
  trailid: number;
  title: string;
  url: string;
  rid: number;
  region_title: string;
  difficulty: number;
  difficulty_label: string;
  latitude: number;
  longitude: number;
  distance_m: number | null;
  alt_climb_m?: number | null;
  rating?: number;
  votes?: number;
  direction?: number;
  status?: number;
  unsanctioned?: number;
  biketype?: string;
  global_rank?: number;
  total_checkins?: number;
  region_pop_rank?: number;
}

export interface TfRegion {
  region_id: number;
  title: string;
  url: string;
  total_trails: number;
  rating: number;
  distance_km: number;
  /** contorno aproximado calculado a partir de sus senderos */
  polygon: LngLat[] | null;
}
