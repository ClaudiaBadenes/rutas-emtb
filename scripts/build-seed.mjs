// Genera los ficheros estáticos que la PWA carga la primera vez:
//  - public/data/seed-trails.json: senderos y zonas de Trailforks ya descargados (sync-trailforks.mjs)
//    + las cuadrículas que cubren por completo, para no volver a pedirlas
//  - public/data/trail-geometry.json: trazados aproximados desde OSM (build_trail_geometry.py)
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const TILE = 0.04;
const KEEP = ["trailid", "title", "url", "rid", "region_title", "difficulty", "difficulty_label", "latitude", "longitude",
  "distance_m", "alt_climb_m", "rating", "votes", "direction", "status", "unsanctioned", "biketype", "trailtype", "global_rank", "total_checkins"];

const hav = (a, b) => { const r = Math.PI / 180; const s = Math.sin((b[1] - a[1]) * r / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin((b[0] - a[0]) * r / 2) ** 2; return 12742018 * Math.asin(Math.sqrt(s)); };

const t = JSON.parse(await readFile(new URL("data/trailforks-trails.json", ROOT), "utf8"));
const r = JSON.parse(await readFile(new URL("data/trailforks-regions.json", ROOT), "utf8"));
const [lon, lat] = t.meta.center;
const radiusM = t.meta.radius_km * 1000;

// Cuadrículas totalmente dentro del círculo descargado
const tiles = [];
const dLat = t.meta.radius_km / 111.32, dLon = t.meta.radius_km / (111.32 * Math.cos((lat * Math.PI) / 180));
for (let ix = Math.floor((lon - dLon) / TILE); ix <= Math.floor((lon + dLon) / TILE); ix++)
  for (let iy = Math.floor((lat - dLat) / TILE); iy <= Math.floor((lat + dLat) / TILE); iy++) {
    const corners = [[ix * TILE, iy * TILE], [(ix + 1) * TILE, iy * TILE], [ix * TILE, (iy + 1) * TILE], [(ix + 1) * TILE, (iy + 1) * TILE]];
    if (corners.every((c) => hav([lon, lat], c) <= radiusM)) tiles.push(`${ix}_${iy}`);
  }

const seed = {
  fetchedAt: Date.parse(t.meta.fetched_at),
  trails: t.trails.map((x) => Object.fromEntries(KEEP.filter((k) => x[k] !== undefined).map((k) => [k, x[k]]))),
  regions: r.regions.filter((x) => x.is_riding_area).map((x) => ({
    region_id: x.region_id, title: x.title, url: x.url, total_trails: x.total_trails, rating: x.rating, latitude: x.latitude, longitude: x.longitude,
  })),
  tiles,
};
await mkdir(new URL("public/data/", ROOT), { recursive: true });
await writeFile(new URL("public/data/seed-trails.json", ROOT), JSON.stringify(seed));
await copyFile(new URL("data/trail-geometry.json", ROOT), new URL("public/data/trail-geometry.json", ROOT));
console.log(`Semilla: ${seed.trails.length} senderos, ${seed.regions.length} zonas, ${tiles.length} cuadrículas cubiertas`);
