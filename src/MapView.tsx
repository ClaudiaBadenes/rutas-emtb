import { useEffect, useRef } from "react";
import maplibregl, { GeoJSONSource, Map as MlMap, Marker } from "maplibre-gl";
import type { Candidate, LngLat } from "../shared/types.ts";
import { DIFFICULTY_COLORS, HIGHLIGHT, SURFACE_COLORS } from "./colors.ts";

export type MapMode = "idle" | "start" | "end" | "waypoint" | "drawPref" | "drawAvoid";

export interface TrailFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: number; title: string; url: string; difficulty: number; label: string; region: string;
    length: number | null; checkins: number; rating: number; ridden: number; importance: number; level: number; geo: "nombre" | "senda" | "acceso" | null;
  };
}

interface Props {
  mode: MapMode;
  start: LngLat;
  end: LngLat | null;
  waypoints: LngLat[];
  prefZone: LngLat[] | null;
  avoidZones: LngLat[][];
  drawing: LngLat[];
  candidates: Candidate[];
  selectedId: string | null;
  hoverPoint: [number, number] | null;
  showTrails: boolean;
  showStrava: boolean;
  /** dibujar los trazados aproximados (OSM) de los senderos */
  showTrailLines: boolean;
  /** trazados aproximados (OSM) como GeoJSON de líneas */
  trailLines: GeoJSON.FeatureCollection;
  /** mis salidas de Strava (GeoJSON de líneas) */
  stravaTracks: GeoJSON.FeatureCollection;
  /** tramo de la ruta seleccionada a resaltar (sendero bajo el ratón) */
  highlight: { range: [number, number]; at: number } | null;
  /** cambia cuando hay nuevos datos de Strava (para recargar la capa) */
  stravaVersion: number;
  /** senderos de Trailforks */
  trails: TrailFeature[];
  chosenTrailIds: number[];
  hoverTrailId: number | null;
  /** hay zona preferida: el popup de un sendero permite elegirlo */
  zoneActive: boolean;
  onToggleTrail: (t: { id: number; point: LngLat; title: string }) => void;
  /** modo Personalizar: puntos de paso editables (null = no se está editando) */
  editVia: LngLat[] | null;
  onViaMove: (i: number, p: LngLat) => void;
  onViaRemove: (i: number) => void;
  onRouteDrag: (grab: LngLat, drop: LngLat) => void;
  onMapClick: (p: LngLat) => void;
  onFinishDraw: () => void;
  onDragPoint: (kind: "start" | "end" | "waypoint", index: number, p: LngLat) => void;
  onSelect: (id: string) => void;
}

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const ROUTE_COLORS = ["#e8590c", "#7048e8", "#1c7ed6", "#2f9e44", "#c2255c"];
const CUSTOM_COLOR = "#0b7285";

const polygonFeature = (ring: LngLat[], props: Record<string, unknown>): GeoJSON.Feature => ({
  type: "Feature", properties: props,
  geometry: { type: "Polygon", coordinates: [[...ring, ring[0]]] },
});

function markerEl(cls: string, text: string) {
  const el = document.createElement("div");
  el.className = `mk ${cls}`;
  el.textContent = text;
  return el;
}

/** Color de cada ruta, igual que en las tarjetas */
function routeColors(cands: Candidate[]) {
  let k = 0;
  return cands.map((c) => (c.id.endsWith("-custom") ? CUSTOM_COLOR : ROUTE_COLORS[k++ % ROUTE_COLORS.length]));
}

export function MapView(props: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const map = useRef<MlMap | null>(null);
  const ready = useRef(false);
  const markers = useRef<Marker[]>([]);
  const viaMarkers = useRef<Marker[]>([]);
  const cb = useRef(props);
  cb.current = props;

  // Crear mapa una vez
  useEffect(() => {
    const m = new maplibregl.Map({
      container: ref.current!,
      attributionControl: { compact: true },
      center: props.start,
      zoom: 11,
      style: {
        version: 8,
        sources: {
          topo: {
            type: "raster",
            tiles: ["a", "b", "c"].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
            tileSize: 256, maxzoom: 17,
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, SRTM · estilo © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA) · senderos © <a href="https://www.trailforks.com">Trailforks</a>',
          },
        },
        layers: [{ id: "topo", type: "raster", source: "topo", paint: { "raster-saturation": -0.25, "raster-opacity": 0.95 } }],
      },
    });
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");
    m.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }), "top-right");
    m.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

    m.on("load", () => {
      m.addSource("zones", { type: "geojson", data: EMPTY });
      m.addLayer({ id: "zones-fill", type: "fill", source: "zones", paint: { "fill-color": ["match", ["get", "kind"], "avoid", "#e03131", "#2f9e44"], "fill-opacity": 0.13 } });
      m.addLayer({ id: "zones-line", type: "line", source: "zones", paint: { "line-color": ["match", ["get", "kind"], "avoid", "#e03131", "#2f9e44"], "line-width": 2, "line-dasharray": [2, 1.5] } });

      // Mis salidas de Strava (debajo de todo lo demás)
      m.addSource("strava", { type: "geojson", data: EMPTY });
      m.addLayer({ id: "strava", type: "line", source: "strava",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#0c8599", "line-width": ["interpolate", ["linear"], ["zoom"], 9, 1.2, 14, 3], "line-opacity": 0.55 } });

      // Trazados aproximados (OSM) de los senderos: continuos si el nombre OSM coincide, discontinuos si solo encaja la senda
      const diffColor = ["match", ["get", "difficulty"], ...Object.entries(DIFFICULTY_COLORS).flatMap(([k, v]) => [Number(k), v === "#ffffff" ? "#9aa0a6" : v]), "#9aa0a6"] as any;
      m.addSource("tf-lines", { type: "geojson", data: EMPTY });
      m.addLayer({ id: "tf-lines-sel", type: "line", source: "tf-lines", filter: ["in", ["get", "id"], ["literal", []]],
        layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": HIGHLIGHT, "line-width": 9, "line-opacity": 0.7 } });
      m.addLayer({ id: "tf-lines-hi", type: "line", source: "tf-lines", minzoom: 11, filter: ["==", ["get", "kind"], "nombre"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": diffColor, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1.2, 15, 3.5], "line-opacity": 0.85 } });
      m.addLayer({ id: "tf-lines-lo", type: "line", source: "tf-lines", minzoom: 11, filter: ["!=", ["get", "kind"], "nombre"],
        paint: { "line-color": diffColor, "line-width": ["interpolate", ["linear"], ["zoom"], 11, 1, 15, 2.8], "line-opacity": 0.7, "line-dasharray": [1.5, 1.5] } });

      // Senderos de Trailforks + elegidos + bajo el ratón
      m.addSource("tf", { type: "geojson", data: EMPTY });
      m.addLayer({
        id: "tf", type: "circle", source: "tf",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, ["+", 1.5, ["*", 0.25, ["ln", ["+", 1, ["get", "checkins"]]]]], 14, ["+", 4, ["*", 0.7, ["ln", ["+", 1, ["get", "checkins"]]]]]],
          "circle-color": ["match", ["get", "difficulty"], ...Object.entries(DIFFICULTY_COLORS).flatMap(([k, v]) => [Number(k), v]), "#9aa0a6"] as any,
          "circle-stroke-color": "#ffffff", "circle-stroke-width": 1, "circle-opacity": 0.9,
        },
      });
      m.addLayer({ id: "tf-chosen", type: "circle", source: "tf", filter: ["in", ["get", "id"], ["literal", []]],
        paint: { "circle-radius": 10, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": HIGHLIGHT, "circle-stroke-width": 3.5 } });
      m.addLayer({ id: "tf-hover", type: "circle", source: "tf", filter: ["==", ["get", "id"], -1],
        paint: { "circle-radius": 14, "circle-color": HIGHLIGHT, "circle-opacity": 0.35, "circle-stroke-color": HIGHLIGHT, "circle-stroke-width": 2 } });

      m.addSource("routes", { type: "geojson", data: EMPTY });
      m.addLayer({ id: "routes-other", type: "line", source: "routes", filter: ["!=", ["get", "selected"], true],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["get", "color"], "line-width": 3, "line-opacity": 0.45 } });
      m.addLayer({ id: "routes-casing", type: "line", source: "routes", filter: ["==", ["get", "selected"], true],
        layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#1d1f21", "line-width": 8.5, "line-opacity": 0.85 } });
      // Sendero bajo el ratón: halo debajo del color de la vía
      m.addSource("hl", { type: "geojson", data: EMPTY });
      m.addLayer({ id: "hl-line", type: "line", source: "hl", filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": HIGHLIGHT, "line-width": 16, "line-opacity": 0.75, "line-blur": 1 } });
      // Ruta seleccionada coloreada por tipo de vía
      m.addSource("surface", { type: "geojson", data: EMPTY });
      m.addLayer({ id: "routes-sel", type: "line", source: "surface",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": ["match", ["get", "kind"], "senda", SURFACE_COLORS.senda, "pista", SURFACE_COLORS.pista, SURFACE_COLORS.asfalto], "line-width": 5 } });
      m.addLayer({ id: "hl-point", type: "circle", source: "hl", filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 7, "circle-color": HIGHLIGHT, "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 } });
      // Callejones (ida y vuelta por un ramal sin salida) de la ruta seleccionada
      m.addSource("deadend", { type: "geojson", data: EMPTY });
      m.addLayer({ id: "deadend", type: "line", source: "deadend",
        layout: { "line-cap": "round" }, paint: { "line-color": "#e03131", "line-width": 4, "line-dasharray": [1, 1.2] } });
      // Tramos de la ruta seleccionada por los que ya has pasado
      m.addSource("known", { type: "geojson", data: EMPTY });
      m.addLayer({ id: "known", type: "line", source: "known",
        paint: { "line-color": "#1d1f21", "line-width": 2.5, "line-dasharray": [1.2, 1.6], "line-opacity": 0.85 } });

      // Zona de agarre ancha e invisible sobre la ruta seleccionada (para arrastrarla con el dedo o el ratón)
      m.addLayer({ id: "routes-hit", type: "line", source: "routes", filter: ["==", ["get", "selected"], true],
        layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#000", "line-width": 22, "line-opacity": 0.001 } });

      // Arrastre del track en modo Personalizar
      m.addSource("ghost", { type: "geojson", data: EMPTY });
      m.addLayer({ id: "ghost-line", type: "line", source: "ghost", filter: ["==", ["geometry-type"], "LineString"],
        paint: { "line-color": CUSTOM_COLOR, "line-width": 3, "line-dasharray": [1, 1] } });
      m.addLayer({ id: "ghost-pt", type: "circle", source: "ghost", filter: ["==", ["geometry-type"], "Point"],
        paint: { "circle-radius": 8, "circle-color": "#fff", "circle-stroke-color": CUSTOM_COLOR, "circle-stroke-width": 3 } });

      m.addSource("draw", { type: "geojson", data: EMPTY });
      m.addLayer({ id: "draw-line", type: "line", source: "draw", paint: { "line-color": "#1c1c1c", "line-width": 2, "line-dasharray": [1, 1] } });
      m.addLayer({ id: "draw-pts", type: "circle", source: "draw", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-radius": 4, "circle-color": "#1c1c1c", "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });

      m.addSource("hover", { type: "geojson", data: EMPTY });
      m.addLayer({ id: "hover", type: "circle", source: "hover", paint: { "circle-radius": 6, "circle-color": "#e8590c", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });

      // ── Interacción ──
      const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "270px" });
      m.on("click", "tf", (e) => {
        if (cb.current.mode !== "idle" || cb.current.editVia) return;
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as any;
        const point = (f.geometry as GeoJSON.Point).coordinates as LngLat;
        const el = document.createElement("div");
        el.className = "tf-popup";
        el.innerHTML = `<b>${escapeHtml(p.title)}</b><br>${escapeHtml(p.label)} · ${p.length ?? "?"} m<br>${escapeHtml(p.region)}${p.checkins ? ` · ${p.checkins} registros` : ""}<br>${p.ridden > 0 ? `<b>Ya has pasado ${p.ridden} ${p.ridden === 1 ? "vez" : "veces"}</b><br>` : ""}<span class="muted">${p.geo === "nombre" ? "Trazado aproximado (OSM, el nombre coincide)" : p.geo ? "Posible trazado (OSM, sin confirmar)" : "Sin trazado en nuestro mapa: usa 👁 para verlo"}</span><br><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Ver en Trailforks ↗</a>`;
        if (cb.current.zoneActive) {
          const chosen = cb.current.chosenTrailIds.includes(p.id);
          const btn = document.createElement("button");
          btn.className = chosen ? "popup-btn on" : "popup-btn";
          btn.textContent = chosen ? "✓ Elegido · quitar" : "＋ Quiero hacer este sendero";
          btn.onclick = () => { cb.current.onToggleTrail({ id: p.id, point, title: p.title }); popup.remove(); };
          el.appendChild(btn);
        }
        popup.setLngLat(e.lngLat).setDOMContent(el).addTo(m);
      });
      for (const id of ["routes-other", "routes-sel"]) {
        m.on("click", id, (e) => {
          const fid = e.features?.[0]?.properties?.id;
          if (cb.current.mode === "idle" && fid) cb.current.onSelect(fid);
        });
        m.on("mouseenter", id, () => { m.getCanvas().style.cursor = cb.current.editVia ? "grab" : "pointer"; });
        m.on("mouseleave", id, () => { m.getCanvas().style.cursor = ""; });
      }
      m.on("mouseenter", "tf", () => { if (cb.current.mode === "idle") m.getCanvas().style.cursor = "pointer"; });
      m.on("mouseleave", "tf", () => { m.getCanvas().style.cursor = ""; });

      // Arrastrar el track para forzar un punto de paso
      let drag: { grab: LngLat; last: LngLat } | null = null;
      const setGhost = (g: LngLat, p: LngLat) => (m.getSource("ghost") as GeoJSONSource).setData({
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [g, p] } },
          { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p } },
        ],
      });
      const startDrag = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
        if (!cb.current.editVia || cb.current.mode !== "idle") return;
        if ("points" in e && e.points.length !== 1) return;
        e.preventDefault();
        const g: LngLat = [e.lngLat.lng, e.lngLat.lat];
        drag = { grab: g, last: g };
        m.dragPan.disable();
        m.getCanvas().style.cursor = "grabbing";
      };
      const moveDrag = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
        if (!drag) return;
        drag.last = [e.lngLat.lng, e.lngLat.lat];
        setGhost(drag.grab, drag.last);
      };
      const endDrag = () => {
        if (!drag) return;
        const { grab, last } = drag;
        drag = null;
        m.dragPan.enable();
        m.getCanvas().style.cursor = "";
        (m.getSource("ghost") as GeoJSONSource).setData(EMPTY);
        const a = m.project(grab), b = m.project(last);
        if (Math.hypot(a.x - b.x, a.y - b.y) > 8) cb.current.onRouteDrag(grab, last);
      };
      m.on("mousedown", "routes-hit", startDrag);
      m.on("touchstart", "routes-hit", startDrag);
      m.on("mouseenter", "routes-hit", () => { if (cb.current.editVia) m.getCanvas().style.cursor = "grab"; });
      m.on("mouseleave", "routes-hit", () => { if (!drag) m.getCanvas().style.cursor = ""; });
      m.on("mousemove", moveDrag);
      m.on("touchmove", moveDrag);
      m.on("mouseup", endDrag);
      m.on("touchend", endDrag);

      ready.current = true;
      sync();
      loadStrava();
      (m.getSource("tf-lines") as GeoJSONSource)?.setData(cb.current.trailLines as any);
    });

    m.on("click", (e) => {
      if (cb.current.mode === "idle") return;
      cb.current.onMapClick([e.lngLat.lng, e.lngLat.lat]);
    });
    m.on("dblclick", (e) => {
      const mode = cb.current.mode;
      if (mode === "drawPref" || mode === "drawAvoid") { e.preventDefault(); cb.current.onFinishDraw(); }
    });

    map.current = m;
    if (import.meta.env.DEV) (window as any).__map = m; // solo para depurar en desarrollo
    return () => { ready.current = false; map.current = null; m.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sync() {
    const m = map.current;
    if (!m || !ready.current || !m.getSource("routes")) return;
    const p = cb.current;

    const zones: GeoJSON.Feature[] = [];
    if (p.prefZone && p.prefZone.length >= 3) zones.push(polygonFeature(p.prefZone, { kind: "pref" }));
    p.avoidZones.forEach((z) => z.length >= 3 && zones.push(polygonFeature(z, { kind: "avoid" })));
    (m.getSource("zones") as GeoJSONSource).setData({ type: "FeatureCollection", features: zones });

    const drawFeatures: GeoJSON.Feature[] = p.drawing.map((c) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c } }));
    if (p.drawing.length >= 2) drawFeatures.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [...p.drawing, p.drawing[0]] } });
    (m.getSource("draw") as GeoJSONSource).setData({ type: "FeatureCollection", features: drawFeatures });

    const colors = routeColors(p.candidates);
    (m.getSource("routes") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: p.candidates.map((c, i) => ({
        type: "Feature",
        properties: { id: c.id, color: colors[i], selected: c.id === p.selectedId },
        geometry: { type: "LineString", coordinates: c.coords.map(([x, y]) => [x, y]) },
      })),
    });
    // Mientras se personaliza, solo se ve la ruta que se edita
    m.setLayoutProperty("routes-other", "visibility", p.editVia ? "none" : "visible");

    const sel = p.candidates.find((c) => c.id === p.selectedId);
    const line = (a: number, b: number) => sel!.coords.slice(a, b + 1).map(([x, y]) => [x, y]);
    (m.getSource("surface") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: (sel?.surfaceSegments ?? []).map(([a, b, kind]) => ({
        type: "Feature", properties: { kind, id: sel!.id }, geometry: { type: "LineString", coordinates: line(a, b) },
      })),
    });
    const hlFeatures: GeoJSON.Feature[] = [];
    if (sel && p.highlight) {
      const [a, b] = p.highlight.range;
      if (b > a) hlFeatures.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line(a, b) } });
      const pt = sel.coords[p.highlight.at];
      if (pt) hlFeatures.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [pt[0], pt[1]] } });
    }
    (m.getSource("hl") as GeoJSONSource).setData({ type: "FeatureCollection", features: hlFeatures });
    (m.getSource("known") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: (sel?.knownRanges ?? []).map(([a, b]) => ({
        type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line(a, b) },
      })),
    });
    (m.getSource("deadend") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: (sel?.stats.deadEnds ?? []).map((d) => ({
        type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line(d.from, d.to) },
      })),
    });
    m.setLayoutProperty("strava", "visibility", p.showStrava ? "visible" : "none");

    (m.getSource("hover") as GeoJSONSource).setData(p.hoverPoint
      ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p.hoverPoint } }] }
      : EMPTY);

    m.setFilter("tf-chosen", ["in", ["get", "id"], ["literal", p.chosenTrailIds]]);
    m.setFilter("tf-lines-sel", ["in", ["get", "id"], ["literal", [...p.chosenTrailIds, ...(p.hoverTrailId != null ? [p.hoverTrailId] : [])]]]);
    for (const id of ["tf-lines-hi", "tf-lines-lo", "tf-lines-sel"]) m.setLayoutProperty(id, "visibility", p.showTrailLines && p.showTrails ? "visible" : "none");
    m.setFilter("tf-hover", ["==", ["get", "id"], p.hoverTrailId ?? -1]);
    for (const id of ["tf", "tf-chosen"]) m.setLayoutProperty(id, "visibility", p.showTrails ? "visible" : "none");
    m.getCanvas().style.cursor = p.mode === "idle" ? "" : "crosshair";
    if (p.mode === "drawPref" || p.mode === "drawAvoid") m.doubleClickZoom.disable(); else m.doubleClickZoom.enable();
  }

  function loadStrava() {
    const m = map.current;
    if (!m || !ready.current || !m.getSource("strava")) return;
    (m.getSource("strava") as GeoJSONSource).setData(cb.current.stravaTracks as any);
  }

  // Trazados aproximados (OSM) de los senderos
  useEffect(() => {
    const m = map.current;
    if (m && ready.current) (m.getSource("tf-lines") as GeoJSONSource)?.setData(props.trailLines as any);
  }, [props.trailLines]);

  // Sincronizar capas
  useEffect(sync, [props.prefZone, props.avoidZones, props.drawing, props.candidates, props.selectedId, props.hoverPoint,
    props.showTrails, props.showStrava, props.mode, props.highlight, props.chosenTrailIds, props.hoverTrailId, props.editVia, props.showTrailLines]);
  // Recargar mis trazas cuando cambian los datos de Strava
  useEffect(() => { loadStrava(); }, [props.stravaVersion, props.stravaTracks]);
  // Datos de senderos
  useEffect(() => {
    const m = map.current;
    const set = () => (m?.getSource("tf") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: props.trails as any });
    if (m && ready.current) set();
    else m?.once("load", () => setTimeout(set, 0));
  }, [props.trails]);

  // Encuadrar la ruta seleccionada (no mientras se personaliza: la vista no debe saltar)
  useEffect(() => {
    const m = map.current;
    const c = props.candidates.find((x) => x.id === props.selectedId);
    if (!m || !c || props.editVia) return;
    const b = new maplibregl.LngLatBounds();
    c.coords.forEach(([x, y]) => b.extend([x, y]));
    const wide = m.getContainer().clientWidth > 700;
    m.fitBounds(b, { padding: { top: 60, bottom: 40, left: 40, right: wide ? 400 : 40 }, duration: 600, maxZoom: 14 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.selectedId, props.candidates]);

  // Marcadores de salida, llegada y pasos
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    markers.current.forEach((mk) => mk.remove());
    const list: Marker[] = [];
    const add = (p: LngLat, cls: string, text: string, kind: "start" | "end" | "waypoint", i: number) => {
      const mk = new maplibregl.Marker({ element: markerEl(cls, text), draggable: true }).setLngLat(p).addTo(m);
      mk.on("dragend", () => { const ll = mk.getLngLat(); cb.current.onDragPoint(kind, i, [ll.lng, ll.lat]); });
      list.push(mk);
    };
    add(props.start, "mk-start", props.end ? "A" : "⟲", "start", 0);
    if (props.end) add(props.end, "mk-end", "B", "end", 0);
    if (!props.editVia) props.waypoints.forEach((w, i) => add(w, "mk-wp", String(i + 1), "waypoint", i));
    markers.current = list;
  }, [props.start, props.end, props.waypoints, props.editVia]);

  // Puntos de paso editables (modo Personalizar): arrastrar = mover, tocar = quitar
  useEffect(() => {
    const m = map.current;
    viaMarkers.current.forEach((mk) => mk.remove());
    viaMarkers.current = [];
    if (!m || !props.editVia) return;
    props.editVia.forEach((v, i) => {
      const el = markerEl("mk-via", String(i + 1));
      el.title = "Arrastra para mover · toca para quitar";
      let moved = false;
      const mk = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(v).addTo(m);
      mk.on("dragstart", () => { moved = true; });
      mk.on("dragend", () => { const ll = mk.getLngLat(); cb.current.onViaMove(i, [ll.lng, ll.lat]); });
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (moved) { moved = false; return; }
        cb.current.onViaRemove(i);
      });
      viaMarkers.current.push(mk);
    });
  }, [props.editVia]);

  return <div ref={ref} className="map" />;
}

function escapeHtml(s: string) {
  return String(s ?? "").replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
