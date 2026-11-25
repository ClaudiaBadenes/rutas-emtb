// Service worker de Rutas eMTB: la app abre al instante y sin conexión.
// - App (HTML/JS/CSS) y datos estáticos: se guardan al instalar y se actualizan en segundo plano.
// - Teselas del mapa: caché limitada (las últimas ~1500) para ver zonas ya visitadas sin cobertura.
// - Trailforks, BRouter y Strava: siempre por red (sus datos ya se guardan en la app).
const VERSION = "v1";
const APP = `app-${VERSION}`;
const TILES = "tiles-v1";
const MAX_TILES = 1500;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(APP).then((c) => c.addAll(["./", "./index.html", "./manifest.webmanifest", "./icons/icon-192.png"])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== APP && k !== TILES).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // Teselas del mapa base: primero caché, si no red (y se guarda)
  if (/tile\.opentopomap\.org|tile\.openstreetmap\.org/.test(url.host)) {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) { c.put(e.request, res.clone()); trimTiles(); }
      return res;
    }));
    return;
  }

  // Solo gestionamos lo de nuestro propio dominio
  if (url.origin !== self.location.origin || url.pathname.startsWith("/brouter")) return;

  // Navegación (HTML): red primero para tener la última versión; sin red, la guardada
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).then((res) => {
      caches.open(APP).then((c) => c.put("./index.html", res.clone()));
      return res;
    }).catch(() => caches.match("./index.html")));
    return;
  }

  // Resto (JS, CSS, datos, iconos): caché y actualización en segundo plano
  e.respondWith(caches.open(APP).then(async (c) => {
    const hit = await c.match(e.request);
    const net = fetch(e.request).then((res) => { if (res.ok) c.put(e.request, res.clone()); return res; }).catch(() => hit);
    return hit ?? net;
  }));
});
