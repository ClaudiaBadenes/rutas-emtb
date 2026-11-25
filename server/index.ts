import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { PlanRequest, RouteRequest } from "../shared/types.ts";
import { plan, GhError, getRecent, routeWithVia, tfLevel } from "./plan.ts";
import { trailQuality } from "./trailforks.ts";
import { gpxFilename, toGpx } from "./gpx.ts";
import { geometry, loadTrailforks, meta, regions, trails } from "./trailforks.ts";
import * as strava from "./strava.ts";

loadTrailforks();
const app = new Hono();
const GH = process.env.GH_URL ?? "http://localhost:8989";

app.get("/api/health", async (c) => {
  let engine = false;
  try { engine = (await fetch(`${GH}/health`)).ok; } catch {}
  return c.json({ engine, trails: trails.length, regions: regions.length, trailforksMeta: meta });
});

app.get("/api/trailforks/trails", (c) =>
  c.json({
    type: "FeatureCollection",
    features: trails.map((t) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [t.longitude, t.latitude] },
      properties: {
        id: t.trailid, title: t.title, url: t.url, difficulty: t.difficulty, label: t.difficulty_label,
        region: t.region_title, length: t.distance_m, checkins: t.total_checkins ?? 0, rating: t.rating ?? 0,
        ridden: strava.visitCount(t.longitude, t.latitude),
        importance: Math.round(trailQuality(t) * 100) / 100,
        level: tfLevel(t.difficulty) ?? -1,
        geo: geometry[t.trailid]?.kind ?? null,
      },
    })),
  }),
);

app.get("/api/trailforks/regions", (c) => c.json(regions));

// Trazados aproximados (OSM) de los senderos, como líneas
app.get("/api/trailforks/geometry", (c) =>
  c.json({
    type: "FeatureCollection",
    features: trails.filter((t) => geometry[t.trailid]).map((t) => ({
      type: "Feature",
      geometry: { type: "LineString", coordinates: geometry[t.trailid].c },
      properties: { id: t.trailid, difficulty: t.difficulty, kind: geometry[t.trailid].kind },
    })),
  }),
);

// ── Strava ──
app.get("/api/strava/status", (c) => c.json(strava.status()));
app.get("/api/strava/login", (c) => {
  const url = strava.authorizeUrl();
  return url ? c.redirect(url) : c.text("Falta STRAVA_CLIENT_ID en .env.local", 400);
});
app.get("/api/strava/callback", async (c) => {
  const { code, state, scope, error } = c.req.query();
  const result = error ? `acceso denegado (${error})` : await strava.handleCallback(code ?? "", state ?? "", scope ?? "");
  if (result === "ok") strava.runSync(); // primera sincronización automática
  return c.redirect(`/?strava=${encodeURIComponent(result)}`);
});
app.post("/api/strava/sync", (c) => { strava.runSync(); return c.json(strava.status()); });
app.post("/api/strava/disconnect", async (c) => { await strava.disconnect(); return c.json(strava.status()); });
app.get("/api/strava/tracks", (c) => c.json(strava.tracksGeoJson()));

// ── GPX (descarga real del servidor: funciona en cualquier navegador y en el móvil) ──
app.get("/api/gpx/:id", (c) => {
  const r = getRecent(c.req.param("id"));
  if (!r) return c.text("Esta ruta ya no está disponible: vuelve a calcular las rutas.", 404);
  return c.body(toGpx(r.candidate, r.name), 200, {
    "Content-Type": "application/gpx+xml; charset=utf-8",
    "Content-Disposition": `attachment; filename="${gpxFilename(r.name)}"`,
  });
});

app.post("/api/route", async (c) => {
  const { req, via } = (await c.req.json()) as RouteRequest;
  try {
    return c.json(await routeWithVia(req, via ?? []));
  } catch (e) {
    const engineDown = /fetch failed|ECONNREFUSED/.test(String((e as any)?.cause ?? (e as Error).message));
    return c.json({ error: engineDown ? "El motor de rutas (GraphHopper) no está arrancado. Ejecuta: npm run engine" : (e as Error).message }, 400);
  }
});

app.post("/api/plan", async (c) => {
  const req = (await c.req.json()) as PlanRequest;
  try {
    const t0 = Date.now();
    const res = await plan(req);
    console.log(`[plan] ${res.candidates.length} candidatas en ${Date.now() - t0} ms`);
    return c.json(res);
  } catch (e) {
    const msg = e instanceof GhError ? e.message : `Error interno: ${(e as Error).message}`;
    if (!(e instanceof GhError)) console.error(e);
    const engineDown = /fetch failed|ECONNREFUSED/.test(String((e as any)?.cause ?? msg));
    return c.json({ error: engineDown ? "El motor de rutas (GraphHopper) no está arrancado. Ejecuta: npm run engine" : msg }, 400);
  }
});

const port = Number(process.env.API_PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`API en http://localhost:${port}`);
