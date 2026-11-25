// Descarga los senderos y zonas de Trailforks alrededor de un punto usando su MCP público
// y los guarda en data/trailforks-*.json para uso local.
//
// El MCP devuelve como máximo 50 senderos por consulta, así que recorremos el área en
// cuadrículas y subdividimos las que llegan al tope. Ritmo: < 60 peticiones/minuto.
//
// Uso: node scripts/sync-trailforks.mjs [lat] [lon] [radio_km]

import { writeFile, mkdir } from "node:fs/promises";

const MCP = "https://www.trailforks.com/mcp/";
const LAT = Number(process.argv[2] ?? 39.676);
const LON = Number(process.argv[3] ?? -0.302);
const RADIUS_KM = Number(process.argv[4] ?? 40);
const CELL_KM = 4;
const MAX_ROWS = 50;
const MIN_INTERVAL_MS = 1100; // ~55 req/min

let last = 0;
let calls = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(name, args) {
  const wait = last + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now();
  calls++;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(MCP, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "ebike-route-planner-poc/0.1" },
        body: JSON.stringify({ jsonrpc: "2.0", id: calls, method: "tools/call", params: { name, arguments: args } }),
      });
      if (res.status === 429) { await sleep(15000); continue; }
      const json = await res.json();
      if (json.error) throw new Error(JSON.stringify(json.error));
      return json.result?.structuredContent ?? {};
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(3000 * (attempt + 1));
    }
  }
}

const kmPerDegLat = 111.32;
const kmPerDegLon = 111.32 * Math.cos((LAT * Math.PI) / 180);
const dLat = RADIUS_KM / kmPerDegLat;
const dLon = RADIUS_KM / kmPerDegLon;
const bbox = { minLat: LAT - dLat, maxLat: LAT + dLat, minLon: LON - dLon, maxLon: LON + dLon };

const trails = new Map();
let capped = 0;

async function scan(cell, depth = 0) {
  const r = await call("search_trails_within_bounds", {
    min_latitude: cell.minLat, max_latitude: cell.maxLat,
    min_longitude: cell.minLon, max_longitude: cell.maxLon,
    rows: MAX_ROWS,
  });
  const list = r.trails ?? [];
  for (const t of list) trails.set(t.trailid, t);
  if (list.length >= MAX_ROWS) {
    if (depth >= 4) { capped++; return; }
    const midLat = (cell.minLat + cell.maxLat) / 2;
    const midLon = (cell.minLon + cell.maxLon) / 2;
    for (const [a, b, c, d] of [
      [cell.minLat, midLat, cell.minLon, midLon], [cell.minLat, midLat, midLon, cell.maxLon],
      [midLat, cell.maxLat, cell.minLon, midLon], [midLat, cell.maxLat, midLon, cell.maxLon],
    ]) await scan({ minLat: a, maxLat: b, minLon: c, maxLon: d }, depth + 1);
  }
}

function insideRadius(cell) {
  // descarta celdas cuyo centro está claramente fuera del círculo
  const cLat = (cell.minLat + cell.maxLat) / 2, cLon = (cell.minLon + cell.maxLon) / 2;
  const dx = (cLon - LON) * kmPerDegLon, dy = (cLat - LAT) * kmPerDegLat;
  return Math.hypot(dx, dy) <= RADIUS_KM + CELL_KM;
}

const cells = [];
const stepLat = CELL_KM / kmPerDegLat, stepLon = CELL_KM / kmPerDegLon;
for (let a = bbox.minLat; a < bbox.maxLat; a += stepLat)
  for (let o = bbox.minLon; o < bbox.maxLon; o += stepLon) {
    const c = { minLat: a, maxLat: Math.min(a + stepLat, bbox.maxLat), minLon: o, maxLon: Math.min(o + stepLon, bbox.maxLon) };
    if (insideRadius(c)) cells.push(c);
  }

console.log(`Petición de senderos: ${cells.length} cuadrículas de ${CELL_KM} km, radio ${RADIUS_KM} km`);
const t0 = Date.now();
for (let i = 0; i < cells.length; i++) {
  await scan(cells[i]);
  if (i % 20 === 0) console.log(`  ${i}/${cells.length} cuadrículas · ${trails.size} senderos · ${calls} llamadas · ${Math.round((Date.now() - t0) / 1000)} s`);
}

// Zonas (riding areas). Su contorno lo calcula el backend a partir de los senderos de cada zona.
// Además pedimos los 50 senderos más populares de cada zona para tener popularidad (checkins, ranking).
const regionsRes = await call("search_regions_near_location", { latitude: LAT, longitude: LON, radius_km: RADIUS_KM, rows: 100 });
const regions = [];
for (const r of regionsRes.regions ?? []) {
  if (!r.is_riding_area) continue;
  regions.push(r);
  const pop = await call("popular_trails_in_area", { region_id: r.region_id, rows: 50 });
  (pop.trails ?? []).forEach((p, i) => {
    const t = trails.get(p.trailid);
    if (t) Object.assign(t, { global_rank: p.global_rank, total_checkins: p.total_checkins, views: p.views, region_pop_rank: i + 1 });
  });
}

await mkdir(new URL("../data/", import.meta.url), { recursive: true });
const meta = { center: [LON, LAT], radius_km: RADIUS_KM, fetched_at: new Date().toISOString(), calls, capped_cells: capped, source: "Trailforks MCP (https://www.trailforks.com/mcp/)" };
await writeFile(new URL("../data/trailforks-trails.json", import.meta.url), JSON.stringify({ meta, trails: [...trails.values()] }));
await writeFile(new URL("../data/trailforks-regions.json", import.meta.url), JSON.stringify({ meta, regions }, null, 1));
console.log(`Listo: ${trails.size} senderos, ${regions.length} zonas, ${calls} llamadas, ${capped} cuadrículas saturadas.`);
