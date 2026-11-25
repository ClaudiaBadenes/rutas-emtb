import { useMemo, useState } from "react";
import type { SurfaceKind, SurfaceSegment } from "../shared/types.ts";
import { HIGHLIGHT, SURFACE_COLORS, SURFACE_LABEL } from "./colors.ts";

interface Props {
  coords: [number, number, number][];
  /** tramos por tipo de vía: colorean el área bajo el perfil */
  segments: SurfaceSegment[];
  /** rango de índices a resaltar (sendero bajo el ratón) */
  highlight: [number, number] | null;
  onHover?: (index: number | null) => void;
}

const W = 340, H = 130, PAD = { l: 34, r: 6, t: 10, b: 18 };

function hav(a: number[], b: number[]) {
  const r = Math.PI / 180;
  const s = Math.sin(((b[1] - a[1]) * r) / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(((b[0] - a[0]) * r) / 2) ** 2;
  return 12742018 * Math.asin(Math.sqrt(s));
}

export function ElevationChart({ coords, segments, highlight, onHover }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const data = useMemo(() => {
    const dist: number[] = [0];
    for (let i = 1; i < coords.length; i++) dist.push(dist[i - 1] + hav(coords[i - 1], coords[i]));
    const eles = coords.map((c) => c[2] ?? 0);
    const minE = Math.min(...eles), maxE = Math.max(...eles);
    const lo = Math.floor(minE / 50) * 50, hi = Math.max(lo + 100, Math.ceil(maxE / 50) * 50);
    const total = dist[dist.length - 1] || 1;
    const x = (d: number) => PAD.l + (d / total) * (W - PAD.l - PAD.r);
    const y = (e: number) => PAD.t + (1 - (e - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
    const base = H - PAD.b;
    const line = coords.map((_, i) => `${i ? "L" : "M"}${x(dist[i]).toFixed(1)},${y(eles[i]).toFixed(1)}`).join("");
    // Un área por cada tramo, con el color de su tipo de vía
    const areas = segments.map(([from, to, kind]) => {
      let d = `M${x(dist[from]).toFixed(1)},${base}`;
      for (let i = from; i <= to; i++) d += `L${x(dist[i]).toFixed(1)},${y(eles[i]).toFixed(1)}`;
      d += `L${x(dist[to]).toFixed(1)},${base}Z`;
      return { d, kind };
    });
    const kindAt: SurfaceKind[] = new Array(coords.length).fill("asfalto");
    for (const [from, to, kind] of segments) for (let i = from; i <= to; i++) kindAt[i] = kind;
    return { dist, eles, lo, hi, total, x, y, line, areas, kindAt, base };
  }, [coords, segments]);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const d = ((px - PAD.l) / (W - PAD.l - PAD.r)) * data.total;
    let idx = data.dist.findIndex((v) => v >= d);
    if (idx < 0) idx = data.dist.length - 1;
    setHover(idx);
    onHover?.(idx);
  };

  const hl = highlight && { x1: data.x(data.dist[highlight[0]]), x2: data.x(data.dist[highlight[1]]) };

  return (
    <svg className="elev" viewBox={`0 0 ${W} ${H}`} onMouseMove={onMove} onMouseLeave={() => { setHover(null); onHover?.(null); }}>
      {data.areas.map((a, i) => <path key={i} d={a.d} fill={SURFACE_COLORS[a.kind]} fillOpacity={0.55} />)}
      {hl && (
        <rect x={hl.x1} width={Math.max(2, hl.x2 - hl.x1)} y={PAD.t - 4} height={data.base - PAD.t + 4}
          fill={HIGHLIGHT} fillOpacity={0.3} stroke={HIGHLIGHT} strokeWidth={1} />
      )}
      <path d={data.line} className="elev-line" />
      {[data.lo, data.hi].map((e) => (
        <text key={e} x={PAD.l - 4} y={data.y(e) + 3} className="elev-axis" textAnchor="end">{e}</text>
      ))}
      <text x={PAD.l} y={H - 4} className="elev-axis">0</text>
      <text x={W - PAD.r} y={H - 4} className="elev-axis" textAnchor="end">{(data.total / 1000).toFixed(1)} km</text>
      {hover !== null && (
        <g>
          <line x1={data.x(data.dist[hover])} x2={data.x(data.dist[hover])} y1={PAD.t} y2={data.base} className="elev-cursor" />
          <text x={Math.min(W - 112, data.x(data.dist[hover]) + 4)} y={PAD.t + 4} className="elev-label">
            {(data.dist[hover] / 1000).toFixed(1)} km · {Math.round(data.eles[hover])} m · {SURFACE_LABEL[data.kindAt[hover]]}
          </text>
        </g>
      )}
    </svg>
  );
}
