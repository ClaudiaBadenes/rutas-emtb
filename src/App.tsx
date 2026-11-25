import { useEffect, useMemo, useState } from "react";
import type {
  AssistMode, Candidate, DifficultyTarget, LngLat, PlanRequest, PlanResponse, RouteType, TfRegion, TrailRef, ZoneStrength,
} from "../shared/types.ts";
import { MapView, type MapMode, type TrailFeature } from "./MapView.tsx";
import { ElevationChart } from "./ElevationChart.tsx";
import { DIFFICULTY_COLORS, SURFACE_COLORS, SURFACE_LABEL } from "./colors.ts";
import { insertPosition, myLocation, pointInPolygon } from "./geoutil.ts";
import { plan as runPlan, routeWithVia, tfLevel } from "./core/plan.ts";
import { ensureArea, loadCache, missingTiles, radiusFor, type SyncProgress } from "./core/tfsync.ts";
import { geometry as coreGeometry, regions as coreRegions, trailQuality, trails as coreTrails } from "./core/trails.ts";
import { visitCount } from "./core/heat.ts";
import { exportGpx, routeTitle } from "./core/export.ts";

const PETRES: LngLat = [-0.3047, 39.6786];
const ROUTE_COLORS = ["#e8590c", "#7048e8", "#1c7ed6", "#2f9e44", "#c2255c"];
const CUSTOM_COLOR = "#0b7285";
const GARMIN_COURSES_URL = "https://connect.garmin.com/modern/courses";

const ROUTE_TYPES: { id: RouteType; label: string; hint: string }[] = [
  { id: "mixta", label: "Mixta", hint: "Equilibrio entre pista y senda" },
  { id: "xc", label: "XC", hint: "Rodadora, poco técnica" },
  { id: "enduro", label: "Enduro", hint: "Subir por pista, bajar por senda" },
  { id: "gravel", label: "Gravel", hint: "Pistas, sin senda técnica" },
];
const TARGETS: { id: DifficultyTarget; label: string; hint: string }[] = [
  { id: "facil", label: "Tranquila", hint: "Senderos fáciles y poco desnivel por km" },
  { id: "media", label: "Moderada", hint: "Senderos de nivel medio (azules)" },
  { id: "dificil", label: "Exigente", hint: "Prioriza senderos difíciles y más senda técnica" },
];
const SCALES = ["S0 · muy fácil", "S1 · fácil", "S2 · media", "S3 · difícil", "S4 · muy difícil", "S5 · extrema"];
const STRENGTHS: { id: ZoneStrength; label: string }[] = [
  { id: "suave", label: "Suave" }, { id: "fuerte", label: "Fuerte" }, { id: "solo", label: "Solo dentro" },
];

const fmt = (n: number, d = 0) => n.toLocaleString("es-ES", { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtTime = (min: number) => `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, "0")} min`;
const isCustom = (c: Candidate) => c.id.endsWith("-custom");

interface MustTrail { id: number; point: LngLat; title: string }

export default function App() {
  const [start, setStart] = useState<LngLat>(PETRES);
  const [startLabel, setStartLabel] = useState<string | null>("Petrés");
  const [circular, setCircular] = useState(true);
  const [end, setEnd] = useState<LngLat | null>(null);
  const [waypoints, setWaypoints] = useState<LngLat[]>([]);
  const [routeType, setRouteType] = useState<RouteType>("mixta");
  const [difficultyTarget, setDifficultyTarget] = useState<DifficultyTarget>("media");
  const [targetKm, setTargetKm] = useState(40);
  const [maxScale, setMaxScale] = useState(2);
  const [batteryWh, setBatteryWh] = useState(800);
  const [assist, setAssist] = useState<AssistMode>("tour");
  const [prefZone, setPrefZone] = useState<{ polygon: LngLat[]; name: string } | null>(null);
  const [strength, setStrength] = useState<ZoneStrength>("fuerte");
  const [avoidZones, setAvoidZones] = useState<LngLat[][]>([]);
  const [mustTrails, setMustTrails] = useState<MustTrail[]>([]);
  const [mode, setMode] = useState<MapMode>("idle");
  const [drawing, setDrawing] = useState<LngLat[]>([]);
  const [regions, setRegions] = useState<TfRegion[]>([]);
  const [tfTrails, setTfTrails] = useState<TrailFeature[]>([]);
  const [showTrails, setShowTrails] = useState(true);
  const [showTrailLines, setShowTrailLines] = useState(true);
  const [health, setHealth] = useState<{ engine: boolean; trails: number } | null>(null);
  const [novelty, setNovelty] = useState(0);
  const [showStrava, setShowStrava] = useState(true);
  /** descarga de senderos de Trailforks para la zona (null = nada pendiente) */
  const [sync, setSync] = useState<SyncProgress | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastReq, setLastReq] = useState<PlanRequest | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [locMsg, setLocMsg] = useState<string | null>(null);
  const [locating, setLocating] = useState<string | null>(null);

  const [result, setResult] = useState<PlanResponse | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverTrail, setHoverTrail] = useState<TrailRef | null>(null);
  const [hoverZoneTrail, setHoverZoneTrail] = useState<number | null>(null);
  /** Modo Personalizar: puntos de paso de la ruta que se está editando */
  const [editing, setEditing] = useState<{ via: LngLat[]; busy: boolean; error: string | null } | null>(null);
  /** tarjeta seleccionada plegada (al volver a pulsarla) */
  const [collapsed, setCollapsed] = useState(false);
  /** vista del trazado oficial de Trailforks */
  const [preview, setPreview] = useState<{ ids: number[]; title: string } | null>(null);
  useEffect(() => setHoverTrail(null), [selectedId, result]);

  /** Pasa los senderos de la caché (en memoria) al formato del mapa y del selector */
  function refreshTrails() {
    setTfTrails(coreTrails.map((t) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [t.longitude, t.latitude] },
      properties: {
        id: t.trailid, title: t.title, url: t.url, difficulty: t.difficulty, label: t.difficulty_label,
        region: t.region_title, length: t.distance_m, checkins: t.total_checkins ?? 0, rating: t.rating ?? 0,
        ridden: visitCount(t.longitude, t.latitude), importance: Math.round(trailQuality(t) * 100) / 100,
        level: tfLevel(t.difficulty) ?? -1, geo: coreGeometry[t.trailid]?.kind ?? null,
      },
    })));
    setRegions(coreRegions);
    setHealth({ engine: true, trails: coreTrails.length });
  }

  // Al abrir: senderos ya guardados en el móvil (la primera vez, la semilla de Petrés)
  useEffect(() => { loadCache(start).then(refreshTrails).catch(() => {}); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  /** Descarga (si falta) la zona que cubre la ruta: radio según salida y distancia */
  async function syncArea() {
    const { center, radiusKm } = radiusFor(start, circular ? null : end, targetKm);
    const missing = await missingTiles(center, radiusKm);
    if (!missing.length) return;
    setSyncError(null);
    setSync({ phase: "senderos", done: 0, total: missing.length, calls: 0 });
    try {
      await ensureArea(center, radiusKm, setSync);
      refreshTrails();
    } catch (e) {
      setSyncError((e as Error).message);
    } finally {
      setSync(null);
    }
  }
  // Cuando cambian la salida, la llegada o la distancia (con un pequeño retardo)
  useEffect(() => {
    const t = setTimeout(() => { syncArea(); }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, circular, targetKm]);

  // Trazados aproximados (OSM) de los senderos que hay en caché
  const trailLines = useMemo<GeoJSON.FeatureCollection>(() => ({
    type: "FeatureCollection",
    features: tfTrails.filter((f) => coreGeometry[f.properties.id]).map((f) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coreGeometry[f.properties.id].c },
      properties: { id: f.properties.id, difficulty: f.properties.difficulty, kind: coreGeometry[f.properties.id].kind },
    })),
  }), [tfTrails]);
  const EMPTY_FC = useMemo<GeoJSON.FeatureCollection>(() => ({ type: "FeatureCollection", features: [] }), []);
  const hasHeat = false; // Strava: pendiente en la versión PWA (función de Cloudflare)
  const selected = useMemo(() => result?.candidates.find((c) => c.id === selectedId) ?? null, [result, selectedId]);
  const hoverPoint = selected && hoverIdx !== null && selected.coords[hoverIdx]
    ? ([selected.coords[hoverIdx][0], selected.coords[hoverIdx][1]] as [number, number]) : null;

  // Senderos dentro de la zona preferida, ordenados por importancia
  const zoneTrails = useMemo(() => {
    if (!prefZone) return [];
    return tfTrails.filter((f) => pointInPolygon(f.geometry.coordinates, prefZone.polygon))
      .sort((a, b) => b.properties.importance - a.properties.importance);
  }, [prefZone, tfTrails]);

  function toggleTrail(f: { id: number; point: LngLat; title: string }) {
    setMustTrails((m) => (m.some((x) => x.id === f.id) ? m.filter((x) => x.id !== f.id) : [...m, f]));
  }

  // ── Ubicación ──
  async function locateMe(target: "start" | "end" | "waypoint") {
    setLocMsg(null);
    setLocating(target);
    try {
      const p = await myLocation();
      if (target === "start") { setStart(p); setStartLabel("Mi ubicación"); }
      else if (target === "end") setEnd(p);
      else setWaypoints((w) => [...w, p]);
    } catch (e) {
      setLocMsg((e as Error).message);
    } finally {
      setLocating(null);
    }
  }

  function onMapClick(p: LngLat) {
    if (mode === "start") { setStart(p); setStartLabel(null); setMode("idle"); }
    else if (mode === "end") { setEnd(p); setMode("idle"); }
    else if (mode === "waypoint") { setWaypoints((w) => [...w, p]); setMode("idle"); }
    else if (mode === "drawPref" || mode === "drawAvoid") setDrawing((d) => [...d, p]);
  }

  function finishDraw() {
    // el doble clic añade vértices repetidos: los quitamos
    const pts = drawing.filter((p, i) => i === 0 || Math.hypot(p[0] - drawing[i - 1][0], p[1] - drawing[i - 1][1]) > 1e-4);
    if (pts.length >= 3) {
      if (mode === "drawPref") setPrefZone({ polygon: pts, name: "Zona dibujada" });
      else setAvoidZones((z) => [...z, pts]);
    }
    setDrawing([]);
    setMode("idle");
  }

  function startDraw(kind: "drawPref" | "drawAvoid") {
    setDrawing([]);
    setMode(kind);
  }

  function buildRequest(over: Partial<PlanRequest> = {}): PlanRequest {
    return {
      start, end: circular ? null : end, waypoints, routeType, targetKm, maxScale,
      prefZone: prefZone ? { polygon: prefZone.polygon, strength } : null,
      avoidZones, battery: { wh: batteryWh, mode: assist },
      novelty: hasHeat ? novelty : 0,
      difficultyTarget,
      mustTrails: prefZone ? mustTrails.map(({ id, point }) => ({ id, point })) : [],
      ...over,
    };
  }

  function onDragPoint(kind: "start" | "end" | "waypoint", i: number, p: LngLat) {
    if (kind === "start") { setStart(p); setStartLabel(null); }
    else if (kind === "end") setEnd(p);
    else setWaypoints((w) => w.map((x, j) => (j === i ? p : x)));
    // En modo Personalizar, mover la salida o la llegada recalcula la ruta
    if (editing && kind !== "waypoint") recalcCustom(editing.via, kind === "start" ? { start: p } : { end: p });
  }

  async function calculate() {
    setLoading(true); setError(null); setEditing(null);
    try {
      await syncArea(); // asegura que los senderos de la zona están descargados
      const req = buildRequest();
      const json = await runPlan(structuredClone(req));
      setLastReq(req);
      setResult(json);
      // En el móvil, volver arriba para ver el mapa y las opciones
      if (window.matchMedia("(max-width: 760px)").matches) window.scrollTo({ top: 0, behavior: "smooth" });
      setSelectedId(json.candidates[0]?.id ?? null);
      setCollapsed(false);
      setPreview(null);
    } catch (e) {
      setError((e as Error).message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  // ── Modo Personalizar ──
  function startEditing(c: Candidate) {
    setSelectedId(c.id);
    setEditing({ via: [...c.via], busy: false, error: null });
  }

  async function recalcCustom(via: LngLat[], over: Partial<PlanRequest> = {}) {
    setEditing({ via, busy: true, error: null });
    try {
      const c = await routeWithVia(structuredClone(buildRequest(over)), via);
      setResult((r) => r && { ...r, candidates: [c, ...r.candidates.filter((x) => !isCustom(x))] });
      setSelectedId(c.id);
      setEditing({ via, busy: false, error: null });
    } catch (e) {
      setEditing({ via, busy: false, error: (e as Error).message });
    }
  }

  const editVia = editing?.via ?? null;
  const onViaMove = (i: number, p: LngLat) => editVia && recalcCustom(editVia.map((v, j) => (j === i ? p : v)));
  const onViaRemove = (i: number) => editVia && recalcCustom(editVia.filter((_, j) => j !== i));
  const onRouteDrag = (grab: LngLat, drop: LngLat) => {
    if (!editVia || !selected) return;
    const pos = insertPosition(selected.coords, editVia, grab);
    recalcCustom([...editVia.slice(0, pos), drop, ...editVia.slice(pos)]);
  };

  const isMobile = /iPhone|iPad|Android/i.test(navigator.userAgent);
  const gpxName = (c: Candidate) => routeTitle(lastReq ?? buildRequest(), c, isCustom(c) ? "personalizada" : `op${optionIndex(c) + 1}`);

  async function downloadGpx(c: Candidate) {
    const r = await exportGpx(c, gpxName(c));
    if (r === "descargado") setToast("GPX descargado");
  }

  async function sendToGarmin(c: Candidate) {
    // Móvil: menú Compartir → app Garmin Connect. Ordenador: descarga + abre Garmin Connect → Recorridos → «Importar»
    if (!isMobile) window.open(GARMIN_COURSES_URL, "_blank", "noopener");
    const r = await exportGpx(c, gpxName(c));
    if (r === "descargado") setToast("GPX descargado: en Garmin Connect pulsa «Importar» y elígelo");
  }
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 5000); return () => clearTimeout(t); }, [toast]);

  const canCalc = !loading && (circular || end) && mode === "idle";
  const drawingNow = mode === "drawPref" || mode === "drawAvoid";
  const optionIndex = (c: Candidate) => result!.candidates.filter((x) => !isCustom(x)).indexOf(c);

  return (
    <div className="app">
      <aside className="panel">
        <header className="brand">
          <div className="logo">⚡</div>
          <div>
            <h1>Rutas eMTB</h1>
            <p className="muted">Prueba de concepto · OSM + Trailforks</p>
          </div>
        </header>

        <section>
          <h2>Recorrido</h2>
          <div className="seg">
            <button className={circular ? "on" : ""} onClick={() => setCircular(true)}>Circular</button>
            <button className={!circular ? "on" : ""} onClick={() => { setCircular(false); if (!end) setMode("end"); }}>De A a B</button>
          </div>
          <div className="row">
            <span className="dot dot-start" />
            <span className="grow">Salida: {startLabel ?? fmtCoord(start)}</span>
            <button className="link" disabled={!!locating} onClick={() => locateMe("start")}>{locating === "start" ? "Buscando…" : "📍 Cerca de mí"}</button>
            <button className="link" onClick={() => setMode("start")}>Mapa</button>
          </div>
          {!circular && (
            <div className="row">
              <span className="dot dot-end" />
              <span className="grow">Llegada: {end ? fmtCoord(end) : "toca el mapa"}</span>
              <button className="link" disabled={!!locating} onClick={() => locateMe("end")}>{locating === "end" ? "Buscando…" : "📍 Cerca de mí"}</button>
              <button className="link" onClick={() => setMode("end")}>Mapa</button>
            </div>
          )}
          {waypoints.map((w, i) => (
            <div className="row" key={i}>
              <span className="dot dot-wp">{i + 1}</span> <span className="grow">Paso: {fmtCoord(w)}</span>
              <button className="link danger" onClick={() => setWaypoints((x) => x.filter((_, j) => j !== i))}>Quitar</button>
            </div>
          ))}
          <div className="two">
            <button className="ghost small" onClick={() => setMode("waypoint")}>+ Punto de paso</button>
            <button className="ghost small" disabled={!!locating} onClick={() => locateMe("waypoint")}>
              {locating === "waypoint" ? "Buscando…" : "📍 Paso cerca de mí"}
            </button>
          </div>
          {locMsg && <p className="small err-text">{locMsg}</p>}
        </section>

        <section>
          <h2>Tipo de ruta</h2>
          <div className="chips">
            {ROUTE_TYPES.map((t) => (
              <button key={t.id} className={`chip ${routeType === t.id ? "on" : ""}`} onClick={() => setRouteType(t.id)} title={t.hint}>{t.label}</button>
            ))}
          </div>
          <p className="muted small">{ROUTE_TYPES.find((t) => t.id === routeType)!.hint}</p>

          <div className="field">
            <span>Hoy busco una ruta…</span>
            <div className="seg small">
              {TARGETS.map((t) => (
                <button key={t.id} className={difficultyTarget === t.id ? "on" : ""} onClick={() => setDifficultyTarget(t.id)} title={t.hint}>{t.label}</button>
              ))}
            </div>
            <p className="muted small">{TARGETS.find((t) => t.id === difficultyTarget)!.hint}</p>
            {difficultyTarget === "dificil" && maxScale < 3 && (
              <p className="small warn-inline">Sube la dificultad máxima a S3 o más para permitir sendas técnicas.</p>
            )}
          </div>

          <label className="field">
            <span>Distancia objetivo <b>{targetKm} km</b></span>
            <input type="range" min={10} max={120} step={5} value={targetKm} onChange={(e) => setTargetKm(+e.target.value)} />
          </label>
          <label className="field">
            <span>Dificultad máxima</span>
            <select value={maxScale} onChange={(e) => setMaxScale(+e.target.value)}>
              {SCALES.map((s, i) => <option key={i} value={i}>{s}</option>)}
            </select>
          </label>
          <div className="two">
            <label className="field">
              <span>Batería (Wh)</span>
              <input type="number" min={200} max={1500} step={25} value={batteryWh} onChange={(e) => setBatteryWh(+e.target.value)} />
            </label>
            <label className="field">
              <span>Asistencia</span>
              <select value={assist} onChange={(e) => setAssist(e.target.value as AssistMode)}>
                <option value="eco">Eco</option><option value="tour">Tour</option><option value="emtb">eMTB</option><option value="turbo">Turbo</option>
              </select>
            </label>
          </div>
        </section>

        <section>
          <h2>Zona preferida <span className="tag">opcional</span></h2>
          {prefZone ? (
            <div className="zone-card">
              <div className="row"><span className="swatch pref" /><span className="grow">{prefZone.name}</span>
                <button className="link danger" onClick={() => { setPrefZone(null); setMustTrails([]); }}>Quitar</button></div>
              <div className="seg small">
                {STRENGTHS.map((s) => <button key={s.id} className={strength === s.id ? "on" : ""} onClick={() => setStrength(s.id)}>{s.label}</button>)}
              </div>
            </div>
          ) : (
            <>
              <button className="ghost small" onClick={() => startDraw("drawPref")}>✎ Dibujar en el mapa</button>
              <select className="region-select" value="" onChange={(e) => {
                const r = regions.find((x) => x.region_id === +e.target.value);
                if (r?.polygon) { setPrefZone({ polygon: r.polygon, name: `${r.title} (Trailforks)` }); setMustTrails([]); }
              }}>
                <option value="">…o elige una zona de Trailforks</option>
                {[...regions].sort((a, b) => a.distance_km - b.distance_km).map((r) => (
                  <option key={r.region_id} value={r.region_id}>{r.title} · {fmt(r.distance_km)} km · {r.total_trails} senderos</option>
                ))}
              </select>
            </>
          )}

          {prefZone && (
            <ZoneTrailPicker
              trails={zoneTrails} chosen={mustTrails} onToggle={toggleTrail}
              onClear={() => setMustTrails([])} onHover={setHoverZoneTrail}
              onPreview={(ids, title) => setPreview({ ids, title })} hasStrava={hasHeat}
            />
          )}

          <h3>Zonas a evitar</h3>
          {avoidZones.map((_, i) => (
            <div className="row" key={i}><span className="swatch avoid" /><span className="grow">Zona a evitar {i + 1}</span>
              <button className="link danger" onClick={() => setAvoidZones((z) => z.filter((_, j) => j !== i))}>Quitar</button></div>
          ))}
          <button className="ghost small" onClick={() => startDraw("drawAvoid")}>✎ Dibujar zona a evitar</button>
        </section>

        <section className="disabled">
          <h2>Strava <span className="tag">próximamente</span></h2>
          <p className="muted small">La conexión con Strava llegará en la versión publicada (necesita una pequeña función en Cloudflare).</p>
        </section>

        <section className={hasHeat ? "" : "disabled"}>
          <h2>Novedad {!hasHeat && <span className="tag">necesita Strava</span>}</h2>
          <input type="range" min={-1} max={1} step={0.1} value={novelty} disabled={!hasHeat}
            onChange={(e) => setNovelty(+e.target.value)} />
          <div className="between muted small"><span>Lo mejor de la zona</span><span>Terreno nuevo</span></div>
          {hasHeat && <p className="muted small">{noveltyLabel(novelty)}</p>}
        </section>

        <div className="sticky">
          {sync && (
            <div className="sync">
              <div className="small">{sync.phase === "popularidad" ? "Popularidad de las zonas" : "Descargando senderos de la zona"}: {sync.done}/{sync.total}</div>
              <div className="progress"><i style={{ width: `${(100 * sync.done) / Math.max(1, sync.total)}%` }} /></div>
              <div className="muted small">Solo la primera vez en esta zona (≈{Math.max(1, Math.round(((sync.total - sync.done) * 1.3) / 60))} min)</div>
            </div>
          )}
          {syncError && <div className="warn">{syncError}</div>}
          {prefZone && mustTrails.length > 0 && <p className="small muted">Incluye {mustTrails.length} sendero{mustTrails.length > 1 ? "s" : ""} elegido{mustTrails.length > 1 ? "s" : ""}</p>}
          <button className="primary" disabled={!canCalc} onClick={calculate}>{loading ? (sync ? "Esperando senderos…" : "Calculando rutas…") : "Calcular rutas"}</button>
        </div>
      </aside>

      <main className="main">
        <MapView
          mode={mode} start={start} end={circular ? null : end} waypoints={waypoints}
          prefZone={prefZone?.polygon ?? null} avoidZones={avoidZones} drawing={drawing}
          candidates={result?.candidates ?? []} selectedId={selectedId} hoverPoint={hoverPoint} showTrails={showTrails}
          highlight={selected && hoverTrail ? { range: hoverTrail.range, at: hoverTrail.at } : null}
          showStrava={showStrava} stravaVersion={0} showTrailLines={showTrailLines} trailLines={trailLines} stravaTracks={EMPTY_FC}
          trails={tfTrails} chosenTrailIds={prefZone ? mustTrails.map((m) => m.id) : []} hoverTrailId={hoverZoneTrail}
          zoneActive={!!prefZone} onToggleTrail={toggleTrail}
          editVia={editVia} onViaMove={onViaMove} onViaRemove={onViaRemove} onRouteDrag={onRouteDrag}
          onMapClick={onMapClick} onFinishDraw={finishDraw} onDragPoint={onDragPoint} onSelect={(id) => { if (!editing) setSelectedId(id); }}
        />

        {mode !== "idle" && (
          <div className="banner">
            {mode === "start" && "Toca el mapa para fijar la salida"}
            {mode === "end" && "Toca el mapa para fijar la llegada"}
            {mode === "waypoint" && "Toca el mapa para añadir un punto de paso"}
            {drawingNow && <>Toca el mapa para añadir vértices ({drawing.length}). Doble clic o «Terminar» para cerrar.</>}
            <div className="banner-actions">
              {drawingNow && <button className="primary small" disabled={drawing.length < 3} onClick={finishDraw}>Terminar</button>}
              <button className="ghost small" onClick={() => { setMode("idle"); setDrawing([]); }}>Cancelar</button>
            </div>
          </div>
        )}

        {editing && mode === "idle" && (
          <div className="banner edit-banner">
            <div>
              <b>Personalizando la ruta</b>
              <div className="small muted">Arrastra el track para forzar un paso · arrastra un punto blanco para moverlo · tócalo para quitarlo</div>
              {editing.error && <div className="small err-text">{editing.error}</div>}
            </div>
            <div className="banner-actions">
              {editing.busy && <span className="small muted">Recalculando…</span>}
              <button className="primary small" onClick={() => setEditing(null)}>Terminar</button>
            </div>
          </div>
        )}

        <div className="map-legend">
          <label><input type="checkbox" checked={showTrails} onChange={(e) => setShowTrails(e.target.checked)} /> Senderos Trailforks {health ? `(${fmt(health.trails)})` : ""}</label>
          <label className="sub-check"><input type="checkbox" checked={showTrailLines} onChange={(e) => setShowTrailLines(e.target.checked)} />
            Trazados desde OSM <span className="muted">— fiable · · · posible</span></label>
          <div className="legend-dots">
            <span><i style={{ background: "#46b414" }} />Fácil</span><span><i style={{ background: "#148cf0" }} />Media</span>
            <span><i style={{ background: "#111" }} />Difícil</span><span><i style={{ background: "#9aa0a6" }} />Sin dato</span>
          </div>
          {selected && (
            <div className="legend-dots legend-surface">
              {(["senda", "pista", "asfalto"] as const).map((k) => (
                <span key={k}><b style={{ background: SURFACE_COLORS[k] }} />{SURFACE_LABEL[k]}</span>
              ))}
            </div>
          )}
          {hasHeat && (
            <label className="legend-strava"><input type="checkbox" checked={showStrava} onChange={(e) => setShowStrava(e.target.checked)} />
              <span className="line-swatch" /> Por donde ya he pasado (Strava)</label>
          )}
        </div>

        {(result || error) && (
          <div className="results">
            {error && <div className="error">{error}</div>}
            {result?.warnings.map((w, i) => <div key={i} className="warn">{w}</div>)}
            {result && (
              <div className="cards">
                {result.candidates.map((c) => {
                  const color = isCustom(c) ? CUSTOM_COLOR : ROUTE_COLORS[optionIndex(c) % ROUTE_COLORS.length];
                  const open = c.id === selectedId && !collapsed;
                  return (
                    <div key={c.id} className={`card-wrap ${open ? "open" : ""}`} style={open ? { borderColor: color } : undefined}>
                      <CandidateCard c={c} label={isCustom(c) ? "Personalizada" : `Opción ${optionIndex(c) + 1}`}
                        color={color} selected={c.id === selectedId} open={open}
                        onClick={() => {
                          if (editing) return;
                          if (c.id === selectedId) setCollapsed((x) => !x);
                          else { setSelectedId(c.id); setCollapsed(false); }
                        }} />
                      {open && (
                        <Detail c={c} onHover={setHoverIdx} hoverTrail={hoverTrail} onHoverTrail={setHoverTrail}
                          editing={!!editing} onEdit={() => startEditing(c)} onGarmin={() => sendToGarmin(c)} onDownload={() => downloadGpx(c)}
                          onPreview={(ids, title) => setPreview({ ids, title })} />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {toast && <div className="toast">{toast}</div>}

        {preview && (
          <TrailPreview ids={preview.ids} title={preview.title} withResults={!!result} onClose={() => setPreview(null)} />
        )}
      </main>
    </div>
  );
}

/** Grupos de dificultad de Trailforks para filtrar (por color) */
const DIFF_GROUPS: { id: string; label: string; color: string; ids: number[] }[] = [
  { id: "verde", label: "Verde", color: "#46b414", ids: [2, 3] },
  { id: "azul", label: "Azul", color: "#148cf0", ids: [4] },
  { id: "negra", label: "Negra", color: "#111111", ids: [5, 10, 11] },
  { id: "roja", label: "Roja / doble negra", color: "#be0014", ids: [6, 8] },
  { id: "acceso", label: "Pista de acceso", color: "#854e85", ids: [1, 7] },
  { id: "sin", label: "Sin dato", color: "#9aa0a6", ids: [] },
];
const groupOf = (difficulty: number) => DIFF_GROUPS.find((g) => g.ids.includes(difficulty))?.id ?? "sin";
/** El widget de Trailforks admite bastantes senderos, pero lo limitamos para que cargue rápido */
const PREVIEW_MAX = 60;

function ZoneTrailPicker({ trails, chosen, onToggle, onClear, onHover, onPreview, hasStrava }: {
  trails: TrailFeature[];
  chosen: MustTrail[];
  onToggle: (t: MustTrail) => void;
  onClear: () => void;
  onHover: (id: number | null) => void;
  onPreview: (ids: number[], title: string) => void;
  hasStrava: boolean;
}) {
  const [all, setAll] = useState(false);
  const [q, setQ] = useState("");
  const [groups, setGroups] = useState<string[]>([]);
  const [onlyNew, setOnlyNew] = useState(false);
  const [sort, setSort] = useState<"importancia" | "longitud" | "nombre">("importancia");

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const t of trails) { const g = groupOf(t.properties.difficulty); c[g] = (c[g] ?? 0) + 1; }
    return c;
  }, [trails]);

  const filtered = useMemo(() => {
    let list = trails.filter((t) =>
      (!groups.length || groups.includes(groupOf(t.properties.difficulty))) &&
      (!onlyNew || !(t.properties.ridden > 0)) &&
      (!q || t.properties.title.toLowerCase().includes(q.toLowerCase())));
    if (sort === "longitud") list = [...list].sort((a, b) => (b.properties.length ?? 0) - (a.properties.length ?? 0));
    if (sort === "nombre") list = [...list].sort((a, b) => a.properties.title.localeCompare(b.properties.title, "es"));
    return list;
  }, [trails, groups, onlyNew, q, sort]);

  const maxImp = Math.max(1, ...trails.map((t) => t.properties.importance));
  const shown = all || q ? filtered : filtered.slice(0, 12);
  const toggleGroup = (id: string) => setGroups((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]));

  if (!trails.length) return <p className="muted small">No hay senderos de Trailforks en esta zona.</p>;
  return (
    <div className="picker">
      <div className="between">
        <b className="small">Senderos de la zona ({trails.length})</b>
        {chosen.length > 0 && <button className="link danger" onClick={onClear}>Quitar elegidos ({chosen.length})</button>}
      </div>
      <p className="muted small">Marca los que quieres hacer sí o sí. Los marcados <b className="geo-ok">entero ↓</b> se recorren de principio a fin en bajada; los de <span className="geo-no">solo punto</span>, solo se pasa por su punto. Con 👁 ves su trazado real.</p>

      <div className="diff-chips">
        {DIFF_GROUPS.filter((g) => counts[g.id]).map((g) => (
          <button key={g.id} className={`dchip ${groups.includes(g.id) ? "on" : ""}`} onClick={() => toggleGroup(g.id)}>
            <i style={{ background: g.color }} />{g.label} <span className="muted">{counts[g.id]}</span>
          </button>
        ))}
      </div>
      <div className="picker-tools">
        <input className="search" placeholder="Buscar sendero…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} title="Ordenar">
          <option value="importancia">Importancia</option>
          <option value="longitud">Longitud</option>
          <option value="nombre">Nombre</option>
        </select>
      </div>
      {hasStrava && (
        <label className="small check"><input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} /> Solo los que no he hecho</label>
      )}
      <div className="preview-links">
        <button className="link" disabled={!filtered.length}
          onClick={() => onPreview(filtered.slice(0, PREVIEW_MAX).map((t) => t.properties.id), `${Math.min(filtered.length, PREVIEW_MAX)} senderos filtrados`)}>
          👁 Ver trazados de la lista{filtered.length > PREVIEW_MAX ? ` (primeros ${PREVIEW_MAX})` : ` (${filtered.length})`}
        </button>
        {chosen.length > 0 && (
          <button className="link" onClick={() => onPreview(chosen.map((c) => c.id), `${chosen.length} senderos elegidos`)}>👁 Ver elegidos ({chosen.length})</button>
        )}
      </div>

      <ul className="tf-rows pick-rows" onMouseLeave={() => onHover(null)}>
        {shown.map((f) => {
          const p = f.properties;
          const on = chosen.some((c) => c.id === p.id);
          return (
            <li key={p.id} className={on ? "chosen" : ""} onMouseEnter={() => onHover(p.id)}
              onClick={() => onToggle({ id: p.id, point: f.geometry.coordinates as LngLat, title: p.title })}>
              <input type="checkbox" checked={on} readOnly />
              <i className="diff" style={{ background: DIFFICULTY_COLORS[p.difficulty] ?? "#9aa0a6" }} title={p.label} />
              <span className="tf-main">
                <span className="tf-title">{p.title}</span>
                <span className="muted small">
                  {p.geo ? <b className="geo-ok" title="Tiene trazado: la ruta lo recorrerá entero, en bajada">entero ↓</b>
                    : <span className="geo-no" title="Sin trazado fiable: la ruta solo pasará por su punto">solo punto</span>}
                  {" · "}{p.length ? `${fmt(p.length)} m · ` : ""}{p.label}{p.checkins ? ` · ${fmt(p.checkins)} registros` : ""}
                </span>
              </span>
              {p.ridden > 0 ? <span className="badge known">×{p.ridden}</span> : <span />}
              <button className="eye" title="Ver su trazado en el mapa de Trailforks"
                onClick={(e) => { e.stopPropagation(); onPreview([p.id], p.title); }}>👁</button>
              <span className="imp"><i style={{ width: `${(100 * p.importance) / maxImp}%` }} /></span>
            </li>
          );
        })}
        {!shown.length && <li className="muted small empty">Ningún sendero con estos filtros.</li>}
      </ul>
      {!q && filtered.length > 12 && (
        <button className="link" onClick={() => setAll((a) => !a)}>{all ? "Ver menos" : `Ver los ${filtered.length}`}</button>
      )}
    </div>
  );
}

/**
 * Trazado oficial de los senderos: mapa de Trailforks embebido (su widget público).
 * Trailforks no ofrece la geometría de los senderos por API, así que es la forma de ver
 * exactamente por dónde va cada uno.
 */
function TrailPreview({ ids, title, withResults, onClose }: { ids: number[]; title: string; withResults: boolean; onClose: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const url = `https://www.trailforks.com/widgets/map/?trailids=${encodeURIComponent(ids.join(","))}&sidebar=${ids.length > 1 ? 1 : 0}`;
  useEffect(() => setLoaded(false), [url]);
  return (
    <div className={`tf-preview ${withResults ? "with-results" : ""}`}>
      <div className="tf-preview-head">
        <div className="grow">
          <b>{title}</b>
          <div className="muted small">Trazado oficial · mapa de Trailforks (el mapa base puede tardar unos segundos)</div>
        </div>
        <a className="link" href={url.replace("/widgets/map/", "/map/")} target="_blank" rel="noopener">Abrir en Trailforks ↗</a>
        <button className="close" onClick={onClose} title="Cerrar">✕</button>
      </div>
      <div className="tf-preview-body">
        {!loaded && <div className="tf-preview-loading muted small">Cargando el mapa de Trailforks…</div>}
        <iframe key={url} src={url} title={`Trailforks: ${title}`} onLoad={() => setLoaded(true)} loading="lazy" />
      </div>
    </div>
  );
}

function CandidateCard({ c, label, color, selected, open, onClick }: { c: Candidate; label: string; color: string; selected: boolean; open: boolean; onClick: () => void }) {
  const s = c.stats;
  const total = Math.max(0.01, s.surface.senda + s.surface.pista + s.surface.asfalto);
  const pct = (k: "senda" | "pista" | "asfalto") => Math.round((100 * s.surface[k]) / total);
  return (
    <button className={`card ${selected ? "sel" : ""} ${open ? "open" : ""}`} onClick={onClick} style={{ borderColor: selected && !open ? color : undefined }} aria-expanded={open}>
      <div className="card-head"><span className="swatch-line" style={{ background: color }} /> {label} <span className="score">{fmt(c.score)}</span><span className={`chev ${open ? "up" : ""}`}>⌄</span></div>
      <div className="card-main">{fmt(s.distanceKm, 1)} km · {fmt(s.ascentM)} m+</div>
      <div className="muted small">
        {s.insideZonePct !== null && <>{fmt(s.insideZonePct)} % en zona · </>}
        {s.newPct !== null && <><b className="new-pct">{fmt(s.newPct)} % nuevo</b> · </>}
        {s.trailforksCount} senderos TF · 🔋 {fmt(Math.max(0, s.batteryLeftPct))} %
        {s.deadEnds.length > 0 && <> · <b className="err-text">⚠ ida y vuelta</b></>}
      </div>
      <div className="card-surface">
        <span className="mini-bar">
          {(["senda", "pista", "asfalto"] as const).map((k) => <i key={k} style={{ flex: s.surface[k] / total, background: SURFACE_COLORS[k] }} />)}
        </span>
        <span className="tiny">Senda {pct("senda")} % · Pista {pct("pista")} % · Asfalto {pct("asfalto")} %</span>
      </div>
    </button>
  );
}

function Detail({ c, onHover, hoverTrail, onHoverTrail, editing, onEdit, onGarmin, onPreview, onDownload }: {
  c: Candidate;
  onHover: (i: number | null) => void;
  hoverTrail: TrailRef | null;
  onHoverTrail: (t: TrailRef | null) => void;
  editing: boolean;
  onEdit: () => void;
  onGarmin: () => void;
  onPreview: (ids: number[], title: string) => void;
  onDownload: () => void;
}) {
  const s = c.stats;
  const total = Math.max(0.01, s.surface.senda + s.surface.pista + s.surface.asfalto);
  const maxImp = Math.max(1, ...c.trailforks.map((t) => t.importance));
  return (
    <div className="detail">
      <div className="detail-actions">
        <button className="primary gpx-btn" onClick={onDownload}>⬇ GPX</button>
        <button className="secondary" onClick={onGarmin} title="Descarga el GPX y abre Garmin Connect → Recorridos">Enviar a Garmin Connect ↗</button>
      </div>
      {!editing && <button className="ghost small edit-btn" onClick={onEdit}>✎ Personalizar esta ruta</button>}
      {s.deadEnds.length > 0 && (
        <div className="warn">
          ⚠ Incluye {s.deadEnds.length === 1 ? "un tramo" : `${s.deadEnds.length} tramos`} de ida y vuelta por un camino sin salida
          ({s.deadEnds.map((d) => `${fmt(d.lengthM)} m`).join(", ")}), marcado en rojo en el mapa.
          Suele deberse a un punto de paso o sendero que has fijado tú: quítalo o muévelo con «Personalizar».
        </div>
      )}
      <details className="garmin-help">
        <summary>¿Cómo llega al Edge 830?</summary>
        <ol>
          <li><b>En el móvil:</b> «Enviar a Garmin Connect» abre el menú Compartir; elige la app <b>Connect</b> (o guárdalo en Archivos e impórtalo desde Connect). Después <b>Enviar al dispositivo</b>.</li>
          <li><b>En el ordenador:</b> descarga el GPX y abre tus Recorridos en Garmin Connect: pulsa <b>Importar</b>, elige el archivo y <b>Guardar</b>. Luego <b>Enviar al dispositivo</b>.</li>
          <li><b>Por cable:</b> conecta el Edge y copia el .gpx en <code>Garmin/NewFiles</code> (en Mac puede hacer falta OpenMTP o Android File Transfer).</li>
        </ol>
      </details>
      {c.chosen.length > 0 && (
        <div className="chosen-block">
          <b className="small">Senderos que elegiste</b>
          {c.chosen.map((t) => (
            <div key={t.id} className="chosen-row">
              <span className="grow">{t.title}</span>
              {t.whole ? (
                <>
                  <span className={`cov ${(t.coverage ?? 0) >= 0.85 ? "ok" : (t.coverage ?? 0) >= 0.5 ? "mid" : "bad"}`}>{fmt(100 * (t.coverage ?? 0))} % recorrido</span>
                  <span className={t.rightWay === false ? "err-text small" : "small muted"}>
                    {t.rightWay === null ? "" : t.rightWay ? (t.ride === "subida" ? "↑ en subida" : "↓ en bajada") : "⚠ en sentido contrario"}
                  </span>
                </>
              ) : (
                <span className="small muted">{t.passes ? "pasa por su punto (sin trazado)" : "⚠ no pasa"}</span>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="detail-grid">
        <Stat label="Distancia" value={`${fmt(s.distanceKm, 1)} km`} />
        <Stat label="Desnivel" value={`+${fmt(s.ascentM)} / −${fmt(s.descentM)} m`} />
        <Stat label="Tiempo estimado" value={fmtTime(s.timeMin)} />
        <Stat label="Batería al llegar" value={`${fmt(Math.max(0, s.batteryLeftPct))} %`} sub={`≈ ${fmt(s.batteryWh)} Wh`} warn={s.batteryLeftPct < 15} />
        {s.insideZonePct !== null && <Stat label="Dentro de la zona" value={`${fmt(s.insideZonePct)} %`} />}
        <Stat label="Tramo técnico (S2+)" value={`${fmt(s.technicalKm, 1)} km`} />
        {s.newPct !== null && <Stat label="Terreno nuevo para ti" value={`${fmt(s.newPct)} %`} sub={`${fmt(s.newKm ?? 0, 1)} km sin pisar`} />}
      </div>
      <div className="surface">
        <div className="surface-bar">
          {(["senda", "pista", "asfalto"] as const).map((k) => <i key={k} style={{ flex: s.surface[k] / total, background: SURFACE_COLORS[k] }} />)}
        </div>
        <div className="between small muted">
          {(["senda", "pista", "asfalto"] as const).map((k) => (
            <span key={k}><i className="sw" style={{ background: SURFACE_COLORS[k] }} />{SURFACE_LABEL[k]} {fmt(s.surface[k], 1)} km</span>
          ))}
        </div>
      </div>
      <ElevationChart coords={c.coords} segments={c.surfaceSegments} highlight={hoverTrail?.range ?? null} onHover={onHover} />

      {c.trailforks.length > 0 && (
        <div className="tf-block">
          <div className="tf-head">
            <b>{c.trailforks.length} senderos de Trailforks</b>
            <span className="muted small">ordenados por importancia · pasa el ratón para verlos en la ruta · 👁 trazado oficial</span>
            <button className="link" onClick={() => onPreview(c.trailforks.slice(0, 60).map((t) => t.id), `Senderos de esta ruta (${c.trailforks.length})`)}>👁 Ver todos en el mapa de Trailforks</button>
          </div>
          <ul className="tf-rows" onMouseLeave={() => onHoverTrail(null)}>
            {c.trailforks.map((t, i) => (
              <li key={t.id} className={hoverTrail?.id === t.id ? "on" : ""} onMouseEnter={() => onHoverTrail(t)}>
                <span className="rank">{i + 1}</span>
                <i className="diff" style={{ background: DIFFICULTY_COLORS[t.difficultyId] ?? "#9aa0a6" }} title={t.difficulty} />
                <span className="tf-main">
                  <a href={t.url} target="_blank" rel="noopener">{t.title}</a>
                  <span className="muted small">
                    {t.lengthM ? `${fmt(t.lengthM)} m · ` : ""}{t.difficulty}{t.checkins ? ` · ${fmt(t.checkins)} registros` : ""} · {t.region}
                  </span>
                </span>
                {t.ridden !== undefined && (t.ridden > 0 ? <span className="badge known">×{t.ridden}</span> : <span className="badge new">nuevo</span>)}
                <button className="eye" title="Ver su trazado en el mapa de Trailforks" onClick={() => onPreview([t.id], t.title)}>👁</button>
                <span className="imp" title="Importancia (popularidad y valoración)"><i style={{ width: `${(100 * t.importance) / maxImp}%` }} /></span>
              </li>
            ))}
          </ul>
          <p className="muted small">El tramo resaltado es aproximado: Trailforks solo da un punto y la longitud de cada sendero.</p>
        </div>
      )}
      <details>
        <summary>Por qué esta puntuación</summary>
        <ul className="tf-list">{Object.entries(c.scoreParts).map(([k, v]) => <li key={k}>{k}: {v > 0 ? "+" : ""}{fmt(v, 1)}</li>)}</ul>
      </details>
      {s.overlapPct > 8 && <p className="muted small">Repite un {fmt(s.overlapPct)} % del recorrido (ida y vuelta por el mismo sitio).</p>}
    </div>
  );
}

function Stat({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className={`stat ${warn ? "warn-text" : ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function noveltyLabel(v: number) {
  if (v >= 0.7) return "Prioriza sitios por los que nunca has pasado.";
  if (v >= 0.3) return "Prefiere terreno nuevo, sin renunciar a buenos senderos.";
  if (v > -0.3) return "Equilibrado: no tiene en cuenta si ya lo conoces.";
  if (v > -0.7) return "Prefiere los mejores senderos, aunque ya los hayas hecho.";
  return "Lo mejor de la zona y tus favoritos (los que más repites).";
}

const fmtCoord = (p: LngLat) => `${p[1].toFixed(4)}, ${p[0].toFixed(4)}`;
