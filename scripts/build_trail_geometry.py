"""
Trazados APROXIMADOS de los senderos de Trailforks a partir de OpenStreetMap.

Trailforks solo da, por sendero, un punto (normalmente el inicio), la longitud, el desnivel
positivo y el sentido. Este script busca en la red de sendas y pistas de OSM el recorrido que
mejor encaja con esos datos:

  1. Lee del .pbf las vías tipo senda/pista/camino de la zona y las parte en tramos entre cruces.
  2. Para cada sendero, engancha su punto a los tramos OSM cercanos (< 35 m).
  3. Explora desde ahí caminos de la longitud del sendero (búsqueda en haz por la red).
  4. Puntúa cada candidato: longitud completa, tipo de vía, nombre OSM parecido, pocos cambios
     de vía, desnivel parecido al de Trailforks y que baje si el sendero es de bajada.
  5. Se queda con el mejor y le asigna una confianza (0-1).

Salida: data/trail-geometry.json  { trails: { <id>: { c: [[lon,lat],...], conf, osm } } }

Uso: .venv/bin/python scripts/build_trail_geometry.py
"""
from __future__ import annotations

import json
import math
import re
import struct
import sys
import time
import unicodedata
import zipfile
from collections import defaultdict
from pathlib import Path

import osmium

ROOT = Path(__file__).resolve().parent.parent
PBF = ROOT / "engine/data/valencia-latest.osm.pbf"
SRTM_DIR = ROOT / "engine/data/srtm"
TRAILS = ROOT / "data/trailforks-trails.json"
OUT = ROOT / "data/trail-geometry.json"

HIGHWAY_WEIGHT = {  # cuánto "parece sendero" cada tipo de vía
    "path": 1.0, "bridleway": 1.0, "footway": 0.8, "cycleway": 0.7, "track": 0.75,
    "steps": 0.2, "unclassified": 0.35, "service": 0.3, "residential": 0.15, "tertiary": 0.1,
}
SNAP_M = 35
BEAM = 60           # caminos vivos por paso en la búsqueda
MAX_EXPANSIONS = 4000


# ── utilidades geográficas ──────────────────────────────────────────────────────────────────
def hav(a, b):
    la1, la2 = math.radians(a[1]), math.radians(b[1])
    dla, dlo = la2 - la1, math.radians(b[0] - a[0])
    s = math.sin(dla / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlo / 2) ** 2
    return 12742018 * math.asin(math.sqrt(min(1, s)))


def project(p, a, b):
    """Proyección de p sobre el segmento ab: (distancia m, t en [0,1])"""
    kx = 111320 * math.cos(math.radians(p[1])); ky = 110540
    ax, ay = (a[0] - p[0]) * kx, (a[1] - p[1]) * ky
    bx, by = (b[0] - p[0]) * kx, (b[1] - p[1]) * ky
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0 if l2 == 0 else max(0, min(1, -(ax * dx + ay * dy) / l2))
    return math.hypot(ax + t * dx, ay + t * dy), t


def norm_name(s: str) -> set[str]:
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    stop = {"de", "del", "la", "el", "los", "las", "a", "y", "i", "sendero", "senda", "trail", "camino", "cami", "variante", "variant"}
    return {w for w in re.findall(r"[a-z0-9]+", s) if w not in stop and len(w) > 1}


# ── altimetría SRTM (mismos ficheros que usa GraphHopper) ──────────────────────────────────
class Srtm:
    def __init__(self):
        self.tiles: dict[str, tuple[int, bytes] | None] = {}

    def _tile(self, lat, lon):
        name = f"{'N' if lat >= 0 else 'S'}{abs(math.floor(lat)):02d}{'E' if lon >= 0 else 'W'}{abs(math.floor(lon)):03d}"
        if name not in self.tiles:
            f = SRTM_DIR / f"{name}.hgt.zip"
            if not f.exists():
                self.tiles[name] = None
            else:
                with zipfile.ZipFile(f) as z:
                    data = z.read(z.namelist()[0])
                self.tiles[name] = (int(math.isqrt(len(data) // 2)), data)
        return self.tiles[name]

    def ele(self, lon, lat):
        t = self._tile(lat, lon)
        if not t:
            return None
        n, data = t
        y = (1 - (lat - math.floor(lat))) * (n - 1)
        x = (lon - math.floor(lon)) * (n - 1)
        x0, y0 = int(x), int(y)
        x1, y1 = min(x0 + 1, n - 1), min(y0 + 1, n - 1)
        def v(xx, yy):
            h = struct.unpack_from(">h", data, 2 * (yy * n + xx))[0]
            return None if h < -1000 else h
        vals = [v(x0, y0), v(x1, y0), v(x0, y1), v(x1, y1)]
        if any(h is None for h in vals):
            return next((h for h in vals if h is not None), None)
        fx, fy = x - x0, y - y0
        return (vals[0] * (1 - fx) + vals[1] * fx) * (1 - fy) + (vals[2] * (1 - fx) + vals[3] * fx) * fy


# ── lectura de OSM ──────────────────────────────────────────────────────────────────────────
class WayReader(osmium.SimpleHandler):
    def __init__(self, bbox):
        super().__init__()
        self.bbox = bbox
        self.ways = []

    def way(self, w):
        hw = w.tags.get("highway")
        if hw not in HIGHWAY_WEIGHT:
            return
        # Caminos donde la bici está prohibida: ni se usan para encajar senderos (GraphHopper tampoco los usa)
        bike = w.tags.get("bicycle")
        if bike in ("no", "dismount") or (w.tags.get("access") in ("no", "private") and bike not in ("yes", "designated", "permissive")):
            return
        try:
            pts = [(n.ref, n.lon, n.lat) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        minx, miny, maxx, maxy = self.bbox
        if not any(minx <= x <= maxx and miny <= y <= maxy for _, x, y in pts):
            return
        self.ways.append({
            "id": w.id, "hw": hw, "pts": pts,
            "name": w.tags.get("mtb:name") or w.tags.get("name") or "",
            "mtb": w.tags.get("mtb:scale"),
        })


def build_graph(ways):
    use = defaultdict(int)
    for w in ways:
        for ref, _, _ in w["pts"]:
            use[ref] += 1
    edges = []
    adj = defaultdict(list)  # nodo cruce → [(edge, 0=inicio / 1=fin)]
    for w in ways:
        pts = w["pts"]
        start = 0
        for i in range(1, len(pts)):
            if i == len(pts) - 1 or use[pts[i][0]] > 1:
                seg = pts[start:i + 1]
                coords = [(x, y) for _, x, y in seg]
                length = sum(hav(coords[k - 1], coords[k]) for k in range(1, len(coords)))
                if length > 0:
                    e = len(edges)
                    edges.append({"w": w, "c": coords, "len": length, "a": seg[0][0], "b": seg[-1][0]})
                    adj[seg[0][0]].append((e, 0))
                    adj[seg[-1][0]].append((e, 1))
                start = i
    return edges, adj


def build_index(edges, cell=0.002):
    idx = defaultdict(list)
    for e, ed in enumerate(edges):
        for k in range(1, len(ed["c"])):
            a, b = ed["c"][k - 1], ed["c"][k]
            for cx in range(int(math.floor(min(a[0], b[0]) / cell)), int(math.floor(max(a[0], b[0]) / cell)) + 1):
                for cy in range(int(math.floor(min(a[1], b[1]) / cell)), int(math.floor(max(a[1], b[1]) / cell)) + 1):
                    idx[(cx, cy)].append((e, k))
    return idx, cell


# ── encaje de un sendero ────────────────────────────────────────────────────────────────────
def snaps(p, edges, index):
    idx, cell = index
    cx, cy = int(math.floor(p[0] / cell)), int(math.floor(p[1] / cell))
    best = {}
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for e, k in idx.get((cx + dx, cy + dy), []):
                c = edges[e]["c"]
                d, t = project(p, c[k - 1], c[k])
                if d < SNAP_M and (e not in best or d < best[e][0]):
                    best[e] = (d, k, t)
    return sorted(((d, e, k, t) for e, (d, k, t) in best.items()))[:5]


def walk_edge(edge, from_end):
    """coords del tramo en el sentido de salida desde el extremo `from_end` (0 inicio, 1 fin)"""
    return edge["c"] if from_end == 0 else edge["c"][::-1]


def candidates_for(trail, edges, adj, index):
    p = (trail["longitude"], trail["latitude"])
    L = trail["distance_m"]
    out = []
    for d0, e, k, t in snaps(p, edges, index):
        c = edges[e]["c"]
        sp = (c[k - 1][0] + (c[k][0] - c[k - 1][0]) * t, c[k - 1][1] + (c[k][1] - c[k - 1][1]) * t)
        # dos sentidos posibles desde el punto enganchado
        heads = [
            ([sp] + c[k:], edges[e]["b"]),            # hacia el final del tramo
            ([sp] + c[:k][::-1], edges[e]["a"]),      # hacia el inicio del tramo
        ]
        for first, node in heads:
            length = sum(hav(first[i - 1], first[i]) for i in range(1, len(first)))
            beam = [{"coords": first, "len": length, "edges": [e], "node": node, "visited": {node}}]
            done = []
            expansions = 0
            while beam and expansions < MAX_EXPANSIONS:
                nxt = []
                for s in beam:
                    if s["len"] >= L:
                        done.append(s); continue
                    branches = [(e2, end) for e2, end in adj.get(s["node"], []) if e2 not in s["edges"]]
                    if not branches:
                        done.append(s); continue  # sin salida: candidato incompleto
                    for e2, end in branches:
                        expansions += 1
                        ed = edges[e2]
                        other = ed["b"] if end == 0 else ed["a"]
                        if other in s["visited"]:
                            continue
                        seg = walk_edge(ed, end)
                        nxt.append({"coords": s["coords"] + seg[1:], "len": s["len"] + ed["len"],
                                    "edges": s["edges"] + [e2], "node": other, "visited": s["visited"] | {other}})
                # poda: priorizar tramos tipo senda y continuidad de la misma vía
                nxt.sort(key=lambda s: -partial_score(s, edges))
                beam = nxt[:BEAM]
            for s in done:
                out.append((d0, s))
    return out


def partial_score(s, edges):
    tot = sum(edges[e]["len"] for e in s["edges"]) or 1
    typ = sum(HIGHWAY_WEIGHT[edges[e]["w"]["hw"]] * edges[e]["len"] for e in s["edges"]) / tot
    switches = sum(1 for i in range(1, len(s["edges"])) if edges[s["edges"][i]]["w"]["id"] != edges[s["edges"][i - 1]]["w"]["id"])
    return typ - 0.08 * switches


def cut_to_length(coords, L):
    out = [coords[0]]
    acc = 0
    for i in range(1, len(coords)):
        d = hav(coords[i - 1], coords[i])
        if acc + d >= L:
            f = (L - acc) / d if d else 0
            out.append((coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * f, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * f))
            return out, L
        out.append(coords[i]); acc += d
    return out, acc


def climb_of(coords, srtm):
    eles = []
    acc = 0
    last = None
    # muestreo cada ~30 m
    for i in range(len(coords)):
        if last is not None and hav(last, coords[i]) < 30 and i != len(coords) - 1:
            continue
        h = srtm.ele(coords[i][0], coords[i][1])
        if h is not None:
            eles.append(h)
        last = coords[i]
    if len(eles) < 2:
        return None, None
    up = sum(max(0, eles[i] - eles[i - 1]) for i in range(1, len(eles)))
    return up, eles[-1] - eles[0]


def evaluate(trail, d0, s, edges, srtm):
    L = trail["distance_m"]
    coords, got = cut_to_length(s["coords"], L)
    completeness = min(1, got / L)
    used = []
    acc = 0
    for e in s["edges"]:
        if acc >= L:
            break
        used.append(e); acc += edges[e]["len"]
    tot = sum(edges[e]["len"] for e in used) or 1
    typ = sum(HIGHWAY_WEIGHT[edges[e]["w"]["hw"]] * edges[e]["len"] for e in used) / tot
    switches = sum(1 for i in range(1, len(used)) if edges[used[i]]["w"]["id"] != edges[used[i - 1]]["w"]["id"])
    # nombre
    tn = norm_name(trail["title"])
    name_hit = 0.0
    osm_names = {edges[e]["w"]["name"] for e in used if edges[e]["w"]["name"]}
    if tn:
        for e in used:
            on = norm_name(edges[e]["w"]["name"])
            if on and len(tn & on) / len(tn) >= 0.5:
                name_hit += edges[e]["len"]
        name_hit /= tot
    # desnivel y sentido
    up, net = climb_of(coords, srtm)
    climb_ok = 0.5
    dir_ok = 0.5
    if up is not None:
        tf_up = trail.get("alt_climb_m") or 0
        climb_ok = max(0, 1 - abs(up - tf_up) / max(40, 0.6 * max(up, tf_up)))
        direction = trail.get("direction")
        if direction in (1, 2):      # bajada
            dir_ok = 1 if net < -5 else (0.4 if net < 10 else 0)
        elif direction in (4, 5):    # subida
            dir_ok = 1 if net > 5 else (0.4 if net > -10 else 0)
    # tipo de vía esperado: accesos → pista; resto → senda
    if trail.get("difficulty") in (1, 7):
        typ = sum((1.0 if edges[e]["w"]["hw"] in ("track", "unclassified", "service") else 0.6) * edges[e]["len"] for e in used) / tot

    score = (2.0 * completeness + 1.5 * typ + 2.0 * name_hit + 1.0 * climb_ok + 1.0 * dir_ok
             - 0.12 * switches - d0 / SNAP_M * 0.5)
    conf = max(0.0, min(1.0, (0.35 * completeness + 0.25 * typ + 0.15 * climb_ok + 0.15 * dir_ok + 0.25 * name_hit
                              - 0.03 * max(0, switches - 2) - 0.1 * d0 / SNAP_M)))
    if completeness < 0.75:
        conf *= completeness
    SENDA = ("path", "footway", "bridleway", "cycleway", "steps")
    path_frac = sum(edges[e]["len"] for e in used if edges[e]["w"]["hw"] in SENDA) / tot
    info = {"name_hit": name_hit, "path_frac": path_frac, "completeness": completeness}
    return score, conf, coords, sorted(osm_names), info


def differs(a, b, tol=40, frac=0.35):
    """True si más de `frac` de los puntos de b están a más de `tol` m de la línea a"""
    if not b:
        return False
    sample = b[:: max(1, len(b) // 25)]
    far = 0
    for p in sample:
        dmin = min(project(p, a[i - 1], a[i])[0] for i in range(1, len(a))) if len(a) > 1 else hav(p, a[0])
        if dmin > tol:
            far += 1
    return far / len(sample) > frac


def main():
    t0 = time.time()
    data = json.loads(TRAILS.read_text())
    trails = [t for t in data["trails"] if t.get("distance_m") and t["distance_m"] >= 40 and t.get("status") != 4]
    lons = [t["longitude"] for t in trails]; lats = [t["latitude"] for t in trails]
    bbox = (min(lons) - 0.05, min(lats) - 0.05, max(lons) + 0.05, max(lats) + 0.05)
    print(f"{len(trails)} senderos · leyendo OSM de {PBF.name} en {tuple(round(x, 3) for x in bbox)}…", flush=True)

    reader = WayReader(bbox)
    reader.apply_file(str(PBF), locations=True, idx="flex_mem")
    print(f"  {len(reader.ways)} vías de senda/pista ({time.time() - t0:.0f} s)", flush=True)
    edges, adj = build_graph(reader.ways)
    index = build_index(edges)
    print(f"  {len(edges)} tramos entre cruces ({time.time() - t0:.0f} s)", flush=True)

    srtm = Srtm()
    out = {}
    ambiguous = 0
    stats = defaultdict(int)
    for i, t in enumerate(trails):
        evaluated = [evaluate(t, d0, s, edges, srtm) for d0, s in candidates_for(t, edges, adj, index)]
        if not evaluated:
            stats["sin_osm_cerca"] += 1
            continue
        evaluated.sort(key=lambda x: -x[0])
        score, conf, coords, names, info = evaluated[0]
        # Ambigüedad: ¿hay otro recorrido DISTINTO que encaje casi igual de bien?
        alt = next((x for x in evaluated[1:] if differs(coords, x[2])), None)
        margin = score - alt[0] if alt else 2.0
        if margin < 0.6:
            ambiguous += 1
        conf = conf * (0.45 + 0.55 * min(1.0, margin / 1.2))
        # Validación contra trazados reales de Trailforks: el encaje solo es de fiar si
        #  - el nombre OSM coincide con el de Trailforks, o
        #  - es un sendero (no pista de acceso) que cae casi entero en sendas OSM, sin alternativa parecida.
        # Si un singletrack acaba encajado en pistas o carreteras, casi siempre es que no está en OSM.
        is_access = t.get("difficulty") in (1, 7)
        if info["name_hit"] >= 0.5 and info["completeness"] >= 0.8:
            kind = "nombre"
        elif not is_access and info["path_frac"] >= 0.8 and info["completeness"] >= 0.85 and margin >= 0.6:
            kind = "senda"
        elif is_access and info["completeness"] >= 0.85 and margin >= 0.6:
            kind = "acceso"
        else:
            kind = "descartado"
        stats[kind] += 1
        if kind == "descartado":
            continue
        # Orientar el trazado en el sentido en que se rueda: de arriba abajo, salvo los de subida
        h0, h1 = srtm.ele(*coords[0]), srtm.ele(*coords[-1])
        uphill = t.get("direction") in (4, 5)
        if h0 is not None and h1 is not None and ((h0 < h1) != uphill):
            coords = coords[::-1]
        drop = None if h0 is None or h1 is None else round(abs(h0 - h1))
        out[str(t["trailid"])] = {
            "c": [[round(x, 5), round(y, 5)] for x, y in coords],
            "ride": "subida" if uphill else "bajada",
            "drop": drop,
            "conf": round(conf, 2),
            "kind": kind,
            "osm": names[:3],
        }
        if i % 200 == 0:
            print(f"  {i}/{len(trails)} ({time.time() - t0:.0f} s)", flush=True)

    OUT.write_text(json.dumps({
        "meta": {"built_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "source": "OSM (© OpenStreetMap contributors) + Trailforks", "stats": stats},
        "trails": out,
    }, separators=(",", ":")))
    print(f"Listo en {time.time() - t0:.0f} s → {OUT.name}: {len(out)} trazados dibujables de {len(trails)} · {dict(stats)} · ambiguos {ambiguous}")


if __name__ == "__main__":
    sys.exit(main())
