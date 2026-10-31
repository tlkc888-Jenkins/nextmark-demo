// The race chart: an SVG plot that fits itself to whatever the course is and
// wherever on earth it happens to be. No fixed extent, no hardcoded coastline.

import { distNm, brgTo, movePt, quadrantArc, D2R } from './geo.js';
import { worldLinesFor, packCovers, clipLines } from './coast.js';

const NS = 'http://www.w3.org/2000/svg';

export const COL = {
  sea: '#07131C', land: '#13232E', landEdge: '#24404F', grid: '#10212E',
  course: '#22C3DA', track: '#FF6A2B', direct: '#FFD24A',
  port: '#E65A5A', stbd: '#2FB376', line: '#FFB347', idle: '#51708A',
  ink: '#DCEAF2', dim: '#6E8AA0', zone: '#C8452F', quad: '#8FD8E8',
  laid: '#B98CE0',
};

function S(tag, attrs) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
  return e;
}

function text(x, y, str, opts = {}) {
  const t = S('text', {
    x, y,
    fill: opts.fill || COL.ink,
    'font-size': opts.size || 9.5,
    'font-family': 'ui-monospace, Consolas, "Arial Narrow", Arial, sans-serif',
    'font-weight': opts.weight || 400,
    'text-anchor': opts.anchor || 'start',
    opacity: opts.opacity,
  });
  t.textContent = str;
  return t;
}

/**
 * Work out the extent to draw.
 *
 * `pts` is everything that must be visible (marks in the course, the boat, the
 * track). In follow mode the box is centred on the boat at a fixed span so the
 * numbers stay readable close in; otherwise it fits the whole course with a
 * margin. Always padded to a minimum span so a single point does not produce a
 * degenerate projection.
 */
export function computeExtent(pts, opts = {}) {
  const follow = opts.follow && opts.boat;
  const minSpanNm = opts.minSpanNm || 0.6;
  let lat0, lat1, lon0, lon1;

  if (follow) {
    const half = (opts.followSpanNm || 3) / 2;
    const b = opts.boat;
    const dLat = half / 60;
    const dLon = half / 60 / Math.max(0.2, Math.cos(b.lat * D2R));
    lat0 = b.lat - dLat; lat1 = b.lat + dLat;
    lon0 = b.lon - dLon; lon1 = b.lon + dLon;
  } else {
    const use = pts.filter(p => p && isFinite(p.lat) && isFinite(p.lon));
    if (!use.length) return { lat0: -1, lat1: 1, lon0: -1, lon1: 1, empty: true };
    lat0 = Math.min(...use.map(p => p.lat)); lat1 = Math.max(...use.map(p => p.lat));
    lon0 = Math.min(...use.map(p => p.lon)); lon1 = Math.max(...use.map(p => p.lon));
    const padLat = Math.max((lat1 - lat0) * 0.14, minSpanNm / 60 / 2);
    const padLon = Math.max((lon1 - lon0) * 0.14, minSpanNm / 60 / 2);
    lat0 -= padLat; lat1 += padLat; lon0 -= padLon; lon1 += padLon;
  }
  return { lat0, lat1, lon0, lon1 };
}

/** Pick a round graticule/scale step for the span on screen. */
function niceStep(spanDeg) {
  const steps = [0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
  for (const s of steps) if (spanDeg / s <= 6) return s;
  return 20;
}

function niceBar(spanNm) {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100];
  for (const s of steps) if (s >= spanNm / 5) return s;
  return 200;
}

export class Chart {
  constructor(svg) {
    this.svg = svg;
    this.W = 480;
    this.H = 480;
    this.ext = null;
    this.cos = 1;
  }

  setExtent(ext, aspect) {
    this.ext = ext;
    const midLat = (ext.lat0 + ext.lat1) / 2;
    this.cos = Math.max(0.05, Math.abs(Math.cos(midLat * D2R)));
    // keep the drawing square-ish in true scale: height follows the latitude span
    const wDeg = (ext.lon1 - ext.lon0) * this.cos;
    const hDeg = ext.lat1 - ext.lat0;
    // fit the extent inside the viewport aspect without distorting scale
    const want = hDeg / wDeg;
    if (aspect && want < aspect) {
      // viewport taller than the data: grow the latitude span
      const grow = (wDeg * aspect - hDeg) / 2;
      this.ext = { ...ext, lat0: ext.lat0 - grow, lat1: ext.lat1 + grow };
    } else if (aspect && want > aspect) {
      const growDeg = (hDeg / aspect - wDeg) / 2 / this.cos;
      this.ext = { ...ext, lon0: ext.lon0 - growDeg, lon1: ext.lon1 + growDeg };
    }
    this.H = Math.round(this.W * (aspect || 1));
  }

  px(p) {
    const e = this.ext;
    return {
      x: (p.lon - e.lon0) / (e.lon1 - e.lon0) * this.W,
      y: (e.lat1 - p.lat) / (e.lat1 - e.lat0) * this.H,
    };
  }

  /** Nautical miles per screen unit, for sizing things in real distance. */
  spanNm() {
    const e = this.ext;
    return (e.lon1 - e.lon0) * this.cos * 60;
  }

  // -------------------------------------------------------------------------

  draw(scene) {
    const svg = this.svg;
    const aspect = scene.aspect || 1;
    this.setExtent(scene.ext, aspect);
    svg.setAttribute('viewBox', `0 0 ${this.W} ${this.H}`);
    svg.replaceChildren();

    this.drawGrid();
    this.drawCoast(scene);
    this.drawZones(scene.zones || []);
    if (scene.nextQuadrant) this.drawQuadrant(scene.nextQuadrant);
    this.drawCourse(scene);
    this.drawTrack(scene.track || []);
    if (scene.boat && scene.nextPos) this.drawDirect(scene.boat, scene.nextPos);
    this.drawMarks(scene);
    if (scene.boat) this.drawBoat(scene.boat);
    this.drawScale(scene);
  }

  drawGrid() {
    const e = this.ext, svg = this.svg;
    const stepLat = niceStep(e.lat1 - e.lat0);
    const stepLon = niceStep((e.lon1 - e.lon0));
    for (let la = Math.ceil(e.lat0 / stepLat) * stepLat; la <= e.lat1; la += stepLat) {
      const p = this.px({ lat: la, lon: e.lon0 });
      svg.append(S('line', { x1: 0, y1: p.y, x2: this.W, y2: p.y, stroke: COL.grid, 'stroke-width': 0.7 }));
    }
    for (let lo = Math.ceil(e.lon0 / stepLon) * stepLon; lo <= e.lon1; lo += stepLon) {
      const p = this.px({ lat: e.lat0, lon: lo });
      svg.append(S('line', { x1: p.x, y1: 0, x2: p.x, y2: this.H, stroke: COL.grid, 'stroke-width': 0.7 }));
    }
  }

  drawCoast(scene) {
    const e = this.ext;
    let lines = [];
    let detailed = false;
    if (scene.packCoast && packCovers(scene.packCoast, e)) {
      lines = scene.packCoast.lines;
      detailed = true;
    } else if (scene.world) {
      lines = worldLinesFor(scene.world, e);
    }
    if (!lines.length) return;
    const margin = (e.lat1 - e.lat0) * 0.6;
    const clipped = clipLines(lines, e, margin);
    const g = S('g', { 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
    for (const l of clipped) {
      let d = '';
      for (let i = 0; i < l.length; i++) {
        const p = this.px({ lat: l[i][0], lon: l[i][1] });
        d += (i ? ' L' : 'M') + ` ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
      }
      g.append(S('path', {
        d, fill: 'none', stroke: COL.landEdge,
        'stroke-width': detailed ? 1.3 : 1.1,
        opacity: detailed ? 1 : 0.8,
      }));
    }
    this.svg.append(g);
  }

  drawZones(zones) {
    for (const z of zones) {
      if (z.type === 'exclusion' && z.lat != null) {
        const c = this.px(z);
        const edge = this.px(movePt(z, 90, (z.radius_m || 100) / 1852));
        const r = Math.max(2.5, Math.abs(edge.x - c.x));
        this.svg.append(S('circle', {
          cx: c.x, cy: c.y, r, fill: COL.zone, 'fill-opacity': 0.12,
          stroke: COL.zone, 'stroke-width': 1, 'stroke-dasharray': '3 2', opacity: 0.85,
        }));
      } else if (z.poly && z.poly.length >= 6) {
        let pts = '';
        for (let i = 0; i < z.poly.length; i += 2) {
          const p = this.px({ lat: z.poly[i], lon: z.poly[i + 1] });
          pts += `${p.x.toFixed(1)},${p.y.toFixed(1)} `;
        }
        this.svg.append(S('polygon', {
          points: pts.trim(), fill: COL.zone, 'fill-opacity': 0.16,
          stroke: COL.zone, 'stroke-width': 1.2, 'stroke-dasharray': '4 2',
        }));
        const p0 = this.px({ lat: z.poly[0], lon: z.poly[1] });
        this.svg.append(text(p0.x + 6, p0.y - 4, z.name, { fill: COL.zone, size: 8, weight: 700 }));
      }
    }
  }

  /** The SI 10.7 rounding quadrant for the mark we are heading to. */
  drawQuadrant(q) {
    const { pos, quad, radiusNm } = q;
    const [from, to] = quadrantArc(quad.b1, quad.b2);
    const c = this.px(pos);
    const a = this.px(movePt(pos, from, radiusNm));
    const b = this.px(movePt(pos, to, radiusNm));
    const rx = Math.hypot(a.x - c.x, a.y - c.y);
    // sweep clockwise in bearing terms, which is clockwise on screen too
    const d = `M ${c.x.toFixed(1)} ${c.y.toFixed(1)} L ${a.x.toFixed(1)} ${a.y.toFixed(1)} ` +
      `A ${rx.toFixed(1)} ${rx.toFixed(1)} 0 0 1 ${b.x.toFixed(1)} ${b.y.toFixed(1)} Z`;
    this.svg.append(S('path', {
      d, fill: COL.quad, 'fill-opacity': 0.14, stroke: COL.quad,
      'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0.9,
    }));
  }

  drawCourse(scene) {
    const seq = scene.seq || [];
    if (seq.length < 2) return;
    const pts = seq.map(w => w.pos).filter(p => p && p.lat != null);
    if (pts.length < 2) return;
    let d = '';
    pts.forEach((p, i) => {
      const q = this.px(p);
      d += (i ? ' L' : 'M') + ` ${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
    });
    this.svg.append(S('path', {
      d, fill: 'none', stroke: COL.course, 'stroke-width': 1.7,
      'stroke-dasharray': '7 5', opacity: 0.85,
    }));
    // direction arrow at the midpoint of each leg
    for (let i = 1; i < pts.length; i++) {
      const a = this.px(pts[i - 1]), b = this.px(pts[i]);
      if (Math.hypot(b.x - a.x, b.y - a.y) < 18) continue;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const an = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
      this.svg.append(S('path', {
        d: 'M -5 -3.4 L 5 0 L -5 3.4 Z', fill: COL.course, opacity: 0.9,
        transform: `translate(${mx.toFixed(1)} ${my.toFixed(1)}) rotate(${an.toFixed(1)})`,
      }));
    }
    // a pinged start/finish line, drawn as the actual line between its ends
    if (scene.lineEnds && scene.lineEnds.length === 2) {
      const a = this.px(scene.lineEnds[0]), b = this.px(scene.lineEnds[1]);
      this.svg.append(S('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: COL.line,
        'stroke-width': 2.4, opacity: 0.95,
      }));
      for (const p of [a, b]) {
        this.svg.append(S('circle', { cx: p.x, cy: p.y, r: 3, fill: COL.line }));
      }
    }
    // a pinned finish: the laid 10 m east-west line, plus a marker that stays
    // visible when the line itself is smaller than a pixel
    if (scene.finishEnds) {
      const a = this.px(scene.finishEnds[0]), b = this.px(scene.finishEnds[1]);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      this.svg.append(S('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: COL.line,
        'stroke-width': 2.4, opacity: 0.95,
      }));
      this.svg.append(S('circle', {
        cx, cy, r: 5.5, fill: 'none', stroke: COL.line, 'stroke-width': 1.6,
        'stroke-dasharray': '2.5 2', opacity: 0.95,
      }));
      this.svg.append(text(cx + 8, cy + 3.5, 'FIN', { fill: COL.line, size: 8.5, weight: 800 }));
    }
  }

  drawTrack(track) {
    if (track.length < 2) return;
    // Draw in runs so a gap in recording shows as a gap, never a straight
    // line across water the boat did not sail.
    const runs = [];
    let run = [];
    for (const f of track) {
      if (f.gap && run.length) { runs.push(run); run = []; }
      run.push(f);
    }
    if (run.length) runs.push(run);
    const g = S('g', { 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
    for (const r of runs) {
      if (r.length < 2) continue;
      let d = '';
      r.forEach((p, i) => {
        const q = this.px(p);
        d += (i ? ' L' : 'M') + ` ${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
      });
      g.append(S('path', { d, fill: 'none', stroke: COL.track, 'stroke-width': 1.6, opacity: 0.9 }));
    }
    this.svg.append(g);
  }

  drawDirect(boat, target) {
    const a = this.px(boat), b = this.px(target);
    this.svg.append(S('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: COL.direct,
      'stroke-width': 1.5, 'stroke-dasharray': '2.5 4', opacity: 0.95,
    }));
  }

  drawMarks(scene) {
    const seq = scene.seq || [];
    const nextIdx = scene.wpIdx;
    // which marks are in the course, and on which side
    const inCourse = new Map();
    seq.forEach((w, i) => {
      if (!inCourse.has(w.id) || i >= nextIdx) inCourse.set(w.id, w);
    });

    for (const m of scene.marks || []) {
      if (m.lat == null) continue;
      const w = inCourse.get(m.id);
      const on = !!w;
      const p = this.px(m);
      const col = m.kind === 'line' ? COL.line
        : m.local ? COL.laid
          : w && w.side === 'P' ? COL.port
            : w && w.side === 'S' ? COL.stbd
              : w ? COL.course : COL.idle;

      if (m.kind === 'line') {
        this.svg.append(S('path', {
          d: `M ${p.x - 5.5} ${p.y + 4} L ${p.x + 5.5} ${p.y + 4} L ${p.x} ${p.y - 6.5} Z`,
          fill: 'none', stroke: col, 'stroke-width': 1.9,
        }));
      } else {
        this.svg.append(S('circle', {
          cx: p.x, cy: p.y, r: on ? 5 : 3.2, fill: on ? col : 'none',
          stroke: col, 'stroke-width': 1.6, opacity: on ? 1 : 0.5,
        }));
      }
      if (m.local) {
        // a mark added on the water: ring it so it reads as not-from-the-SI
        this.svg.append(S('circle', {
          cx: p.x, cy: p.y, r: 8.5, fill: 'none', stroke: COL.laid,
          'stroke-width': 1, 'stroke-dasharray': '2 2', opacity: 0.9,
        }));
      }
      const label = m.short || m.id;
      const t = text(p.x + 9, p.y + 3.5, label, {
        fill: on ? COL.ink : COL.idle, weight: on ? 700 : 400, size: 9.5,
      });
      if (w && w.side) {
        const s = S('tspan', { fill: w.side === 'P' ? COL.port : COL.stbd, 'font-weight': 800 });
        s.textContent = ' ' + w.side;
        t.append(s);
      }
      this.svg.append(t);
    }
  }

  drawBoat(boat) {
    const p = this.px(boat);
    const hdg = isFinite(boat.cog) ? boat.cog : 0;
    const g = S('g', { transform: `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})` });
    // accuracy halo, in real distance, when the fix is poor
    if (boat.acc != null && boat.acc > 15) {
      const edge = this.px(movePt(boat, 90, boat.acc / 1852));
      const r = Math.abs(edge.x - p.x);
      if (r > 4) {
        this.svg.append(S('circle', {
          cx: p.x, cy: p.y, r, fill: COL.track, 'fill-opacity': 0.08,
          stroke: COL.track, 'stroke-width': 0.8, 'stroke-dasharray': '2 3', opacity: 0.6,
        }));
      }
    }
    g.append(S('path', {
      d: 'M 0 -9 L 5 6.5 L 0 3.6 L -5 6.5 Z', fill: COL.track,
      stroke: '#fff', 'stroke-width': 0.8,
      transform: `rotate(${hdg.toFixed(1)})`,
    }));
    this.svg.append(g);
  }

  drawScale(scene) {
    const spanNm = this.spanNm();
    const bar = niceBar(spanNm);
    const w = bar / spanNm * this.W;
    const y = this.H - 16;
    const g = S('g', { opacity: 0.85 });
    g.append(S('line', { x1: 14, y1: y, x2: 14 + w, y2: y, stroke: COL.dim, 'stroke-width': 2 }));
    g.append(S('line', { x1: 14, y1: y - 3, x2: 14, y2: y + 3, stroke: COL.dim, 'stroke-width': 2 }));
    g.append(S('line', { x1: 14 + w, y1: y - 3, x2: 14 + w, y2: y + 3, stroke: COL.dim, 'stroke-width': 2 }));
    g.append(text(14, y - 6, `${bar} nm`, { fill: COL.dim, size: 9 }));
    // north arrow
    const nx = this.W - 20, ny = 22;
    g.append(S('path', {
      d: `M ${nx} ${ny + 9} L ${nx} ${ny - 9}`, stroke: COL.dim, 'stroke-width': 1.4,
    }));
    g.append(S('path', {
      d: `M ${nx - 3.5} ${ny - 4} L ${nx} ${ny - 10} L ${nx + 3.5} ${ny - 4} Z`, fill: COL.dim,
    }));
    g.append(text(nx, ny + 19, 'N', { fill: COL.dim, size: 8.5, anchor: 'middle', weight: 700 }));
    if (scene.coastNote) {
      g.append(text(14, 16, scene.coastNote, { fill: COL.dim, size: 8, opacity: 0.8 }));
    }
    this.svg.append(g);
  }
}

/**
 * Thin a track for drawing without losing its shape.
 *
 * Every-Nth subsampling cut the apex off tacks — the one part of the track a
 * sailor actually studies. Douglas–Peucker instead drops only points that lie
 * on the line between their neighbours: a straight leg thins to its two ends
 * while every tack, duck and wind shift survives, within `tolNm` of the truth
 * (default ~5.5 m, under GPS accuracy). Gap markers and flagged fixes are
 * breakpoints that always survive, so roundings and resume points never
 * disappear from the picture.
 */
export function thinTrack(track, tolNm = 0.003) {
  if (track.length < 3) return track;
  const n = track.length;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;

  const anchors = [0];
  for (let i = 1; i < n - 1; i++) {
    if (track[i].gap || track[i].flags) { keep[i] = 1; anchors.push(i); }
  }
  anchors.push(n - 1);

  // local flat projection in nautical miles — fine at race scale
  const kx = Math.cos(track[0].lat * D2R);
  const X = i => track[i].lon * kx * 60;
  const Y = i => track[i].lat * 60;

  const stack = [];
  for (let a = 0; a + 1 < anchors.length; a++) stack.push([anchors[a], anchors[a + 1]]);
  while (stack.length) {
    const [i0, i1] = stack.pop();
    if (i1 - i0 < 2) continue;
    const x0 = X(i0), y0 = Y(i0);
    const dx = X(i1) - x0, dy = Y(i1) - y0;
    const len = Math.hypot(dx, dy);
    let worst = -1, wd = tolNm;
    for (let i = i0 + 1; i < i1; i++) {
      const d = len < 1e-9
        ? Math.hypot(X(i) - x0, Y(i) - y0)
        : Math.abs(dx * (Y(i) - y0) - dy * (X(i) - x0)) / len;
      if (d > wd) { wd = d; worst = i; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([i0, worst], [worst, i1]); }
  }

  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(track[i]);
  return out;
}
