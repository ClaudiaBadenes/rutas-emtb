# Rutas eMTB

Diseñador de rutas para bici eléctrica de montaña (alrededores de Petrés y donde quieras), pensado para
un grupo de amigos. Es una **PWA**: una web que se instala en el móvil (iPhone y Android) y funciona
**sin servidor propio**.

## Arquitectura (todo en el navegador)

| Pieza | Dónde |
|---|---|
| App: mapa, formulario, planificador, callejones, GPX | `src/` (React + MapLibre), compilada a estático |
| Cálculo de rutas | **BRouter**: brouter.de en producción; servidor local en desarrollo (`npm run brouter`) |
| Senderos de Trailforks | Se descargan **desde el móvil** por radio (salida + distancia) y se guardan en IndexedDB (cuadrículas de ~4 km, 14 días) |
| Semilla (solo en local) | `public/data/seed-trails.json`: 2.100 senderos de alrededor de Petrés; no se publica |
| Trazados aproximados (OSM) | `public/data/trail-geometry.json` (generado por `scripts/build_trail_geometry.py`) |
| Instalable y sin conexión | `public/manifest.webmanifest`, `public/sw.js`, iconos en `public/icons/` |
| Strava | Pendiente: necesitará una función de Cloudflare para el intercambio del token |

El código del planificador está en `src/core/` (`plan.ts`, `brouter.ts`, `tfsync.ts`, `spurs.ts`…).
La carpeta `server/` y `engine/` (GraphHopper) son la versión anterior con servidor, ya sin uso.

## Probar en local

```bash
npm run brouter        # BRouter local en :17777 (mapas en brouter/segments4)
npm run dev            # app en http://localhost:5173 (usa el BRouter local)
```

Versión compilada, igual que la publicada (usa **brouter.de**):

```bash
npm run build && npm run preview    # http://localhost:4173
```

## Publicar (GitHub Pages)

Cada cambio en la rama `main` se compila y publica solo con GitHub Actions
(`.github/workflows/deploy.yml`) en `https://<usuario>.github.io/rutas-emtb/`.

- La versión publicada **no incluye la semilla** de senderos de Trailforks (`public/data/seed-trails.json`
  no se sube): cada móvil los descarga directamente de Trailforks la primera vez (≈3 min en Petrés).
- Sí incluye los trazados aproximados desde OSM (`public/data/trail-geometry.json`, © OpenStreetMap, ODbL).
- Para regenerar la semilla en local: `npm run sync:trailforks && npm run build:seed`.

## Qué hace

| Función | Estado |
|---|---|
| Ruta circular o de A a B, puntos de paso arrastrables | ✅ |
| Tipo de ruta: mixta / XC / enduro / gravel | ✅ (preferencias por tipo de vía, pendiente y `mtb:scale`) |
| Dificultad máxima (S0–S5) | ✅ (solo donde OSM tiene `mtb:scale`) |
| Zona preferida (dibujada o zona de Trailforks) con intensidad suave / fuerte / solo dentro | ✅ |
| Zonas a evitar | ✅ |
| Varias propuestas puntuadas (distancia, senderos Trailforks, terreno, zona, repeticiones, batería) | ✅ |
| Perfil de altimetría, reparto senda/pista/asfalto, batería estimada | ✅ |
| Exportar GPX (descarga desde el servidor, nombre y descripción listos para Garmin) | ✅ |
| «Enviar a Garmin Connect»: descarga el GPX y abre Garmin Connect → Recorridos para importarlo | ✅ |
| Objetivo de dificultad (tranquila / moderada / exigente), además de la dificultad máxima | ✅ |
| Selector de senderos de la zona preferida (lista por importancia + mapa) para hacerlos sí o sí | ✅ |
| Filtro por dificultad (verde / azul / negra / roja…), «solo los que no he hecho» y orden | ✅ |
| Trazado oficial de cada sendero (👁): mapa de Trailforks embebido, de uno, de los elegidos o de los filtrados | ✅ |
| Tarjetas plegables: el detalle se abre debajo de la opción elegida | ✅ |
| Senderos elegidos con trazado: la ruta los recorre **enteros y en bajada** (bloque entrada → intermedios → salida); el detalle muestra % recorrido y sentido | ✅ |
| Trazados de senderos desde OSM en nuestro mapa (solo los encajes de fiar: ~300 de 2.100) · `npm run build:trail-geometry` | ✅ parcial |
| Sin callejones: no da media vuelta en los puntos de paso (`pass_through`), recoloca los puntos automáticos que caen en ramales sin salida y penaliza/avisa los que quedan (marcados en rojo) | ✅ |
| Modo Personalizar: arrastrar el track para forzar un paso, mover o quitar pasos | ✅ |
| «Cerca de mí» para salida, llegada y puntos de paso | ✅ (pide permiso de ubicación al navegador) |
| Ruta y perfil coloreados por senda / pista / asfalto; % de cada uno en las tarjetas | ✅ |
| Strava: conexión, sincronización y mapa de calor personal (celdas de ~22 m) | ✅ |
| Control *Lo mejor de la zona ↔ Terreno nuevo*: puntos de paso, ranking, % nuevo por ruta, tramos conocidos en el mapa | ✅ |
| Capa "por donde ya he pasado" y senderos Trailforks marcados como nuevos o ×N | ✅ |
| Emparejar cada sendero de Trailforks con su tramo OSM | ⏳ (ahora: cercanía del punto de Trailforks a la ruta) |

## Cómo se generan las rutas

1. El backend construye un *custom model* de GraphHopper por petición: preferencias del tipo de ruta, dificultad máxima, zona preferida (penaliza salir de ella) y zonas a evitar (prohibidas).
2. Para rutas circulares, elige combinaciones de 2–4 puntos de paso (preferentemente senderos de Trailforks populares) dentro de la zona preferida, o en un círculo alcanzable si no hay zona. Se quedan las que en línea recta se acercan a la distancia objetivo ÷ 1,35.
3. Calcula cada candidata, mide sus estadísticas y las ordena por puntuación.

## Limitaciones conocidas

- Trailforks no da el trazado de los senderos por API (solo un punto y la longitud). En nuestro mapa se ven como puntos; el trazado exacto se ve con 👁 en su mapa embebido. Que una ruta "pasa por" un sendero es una aproximación: su punto está a menos de 60 m de la ruta.
- El filtro E-Bike de Trailforks indica popularidad, no permiso. Las restricciones de parques naturales (Calderona, Espadán) hay que dibujarlas como zonas a evitar.
- El modelo de batería es una estimación (5 Wh/km + 0,22 Wh por metro de subida × factor del modo de asistencia). Se calibrará con Strava.
- Los datos de Trailforks se guardan solo en local, para uso personal.
- **Novedad:** influye en qué puntos de paso se eligen y en el ranking, pero el motor de rutas aún no
  sabe por dónde has pasado al unir esos puntos. Por eso una ruta "nueva" puede compartir tramos
  de aproximación conocidos. Siguiente mejora: penalizar en GraphHopper los tramos ya recorridos.

## Trazados de senderos desde OSM (aproximados)

Trailforks no da la geometría de sus senderos, así que `scripts/build_trail_geometry.py` la reconstruye
encajando cada sendero (punto + longitud + desnivel + sentido) en la red de sendas de OpenStreetMap.

Validado a mano contra el trazado oficial de Trailforks en 7 senderos:

| Clase | Cómo se dibuja | Resultado en la validación |
|---|---|---|
| **nombre** (el nombre OSM coincide), 152 senderos | línea continua | 1 confirmado, 1 coherente |
| **senda** (encaja en sendas OSM sin alternativa parecida), 155 | línea discontinua («posible») | 1 de 2 correcto |
| resto, 1.705 | no se dibuja | 0 de 2 correctos: suelen ser singletracks que no están en OSM |

Para ver el trazado exacto de cualquier sendero, usa 👁 (mapa oficial de Trailforks).

### Recorrer enteros los senderos elegidos

Si un sendero elegido tiene trazado (los marcados «entero ↓»), el planificador lo convierte en un bloque de
puntos de paso que va siempre junto y en orden: entrada (arriba) → dos intermedios → salida (abajo).
El sentido se decide con la altimetría SRTM y el campo `direction` de Trailforks (los de «solo subida» se suben).
Los intermedios son «blandos»: si GraphHopper no puede seguirlos (p. ej. un tramo con `bicycle=no`), se quitan.

Comparativa (Calderona-Gilet, mixta, 40 km; % del trazado recorrido en las 5 opciones):

| Sendero | Antes (solo su punto) | Ahora (entero) |
|---|---|---|
| Oculta 1 | 14 % | 100 %, en bajada |
| El Dragon | 77-87 %, 3 de 5 en subida | 93 %, 4 de 5 en bajada |
| Dragón Baja | 76-86 %, 3 de 5 en subida | 86-87 %, todas en bajada |
| Furgoneta | 100 % | 100 % |

## Motor de rutas: GraphHopper o BRouter

El planificador funciona con los dos motores (mismo formato de ruta). Por defecto GraphHopper;
`ROUTE_ENGINE=brouter` (o `engine: "brouter"` en la petición) usa BRouter.

- BRouter local: `npm run brouter` (puerto 17777, mapa `brouter/segments4/W5_N35.rd5`, 62 MB).
- BRouter remoto: `BROUTER_URL=https://brouter.de/brouter` (los perfiles eMTB se suben solos).
- Perfiles eMTB generados en `server/brouter.ts` a partir de `mtb.brf` / `gravel.brf` de BRouter.

### Comparativa (19 escenarios alrededor de Petrés, 40 km, mismo planificador)

| | GraphHopper | BRouter |
|---|---|---|
| Tiempo por «Calcular rutas» (local) | 0,2 s | 0,9 s |
| Senda / pista / asfalto (mejor opción) | 21 % / 50 % / 29 % | **32 % / 55 % / 13 %** |
| Error frente a la distancia objetivo | 3,5 km | 3,6 km |
| Desnivel medio | 1.116 m | 1.070 m |
| % dentro de la zona preferida | **82 %** | 69 % |
| Senderos Trailforks por ruta | **34,5** | 29,3 |
| Callejones (95 opciones) | 20 (2,7 km) | **2 (0,3 km)** |
| Senderos elegidos recorridos enteros y en bajada | 19/20 | **20/20** |

brouter.de: acepta el perfil propio; ~250 ms por ruta (picos de varios segundos por ser compartido).
