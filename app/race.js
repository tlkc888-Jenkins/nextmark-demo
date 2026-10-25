// The race model: course packs, the course you build at the briefing, and the
// rounding engine that decides when you have passed a mark.

import {
  distNm, distM, brgTo, movePt, pickQuadrant, inQuadrant, crossesLine,
  quadrantArc, inArc, fmtDDM, fmtBrg,
} from './geo.js';
import {
  FLAG_RESUME, FLAG_ROUNDED, FLAG_MANUAL, FLAG_START, FLAG_FINISH,
} from './store.js';

/** Rounding radius used when a mark has no published quadrant. */
export const PROX_NM = 0.04;        // ~74 m
/** How close you must be for a quadrant fix to count as a rounding. */
export const QUAD_NM = 0.11;        // ~200 m, matching the SI off-station figure

export async function loadPack(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('course pack unavailable (' + res.status + ')');
  return res.json();
}

/**
 * A course under construction or being sailed.
 *
 * `legs` is what the sailor built at the briefing: an ordered list of
 * {markId, side} where side is 'P', 'S' or 'G' (a gate, either mark). The
 * start and finish are added automatically at each end.
 */
export class Course {
  constructor(pack, opts = {}) {
    this.pack = pack;
    this.courseId = opts.courseId || 'X1';
    this.division = opts.division || 'D2';
    this.legs = opts.legs ? opts.legs.map(l => ({ ...l })) : [];
    this.localMarks = opts.localMarks ? opts.localMarks.map(m => ({ ...m })) : [];
    this.lineEnds = opts.lineEnds ? opts.lineEnds.map(p => ({ ...p })) : [];
    this.windFrom = opts.windFrom == null ? null : opts.windFrom;
    this.finishSame = opts.finishSame !== false;
  }

  toJSON() {
    return {
      courseId: this.courseId, division: this.division,
      legs: this.legs, localMarks: this.localMarks,
      lineEnds: this.lineEnds, windFrom: this.windFrom, finishSame: this.finishSame,
    };
  }

  /** Every mark available to the builder: pack marks plus ones added on the water. */
  allMarks() {
    const out = [];
    for (const m of this.pack.marks) {
      out.push({ ...m, short: m.id, source: 'si' });
    }
    for (const m of this.localMarks) {
      out.push({ ...m, short: m.id, source: 'local', local: true });
    }
    return out;
  }

  markById(id) {
    return this.allMarks().find(m => m.id === id) || null;
  }

  /** Add a mark typed in on the water (RC adds a mark over VHF). */
  addLocalMark({ id, name, lat, lon, note }) {
    const taken = new Set(this.allMarks().map(m => m.id));
    let useId = (id || 'NEW').toUpperCase().slice(0, 6);
    if (taken.has(useId)) {
      let n = 2;
      while (taken.has(useId + n)) n++;
      useId = useId + n;
    }
    const m = {
      id: useId, name: name || ('Added mark ' + useId), lat, lon,
      kind: 'course', note: note || 'Added on the water, not from the published SIs.',
      addedAt: Date.now(),
    };
    this.localMarks.push(m);
    return m;
  }

  removeLocalMark(id) {
    this.localMarks = this.localMarks.filter(m => m.id !== id);
    this.legs = this.legs.filter(l => l.markId !== id);
  }

  /** Where the start (and finish, unless separate) line sits. */
  startPos() {
    if (this.lineEnds.length === 2) {
      return {
        lat: (this.lineEnds[0].lat + this.lineEnds[1].lat) / 2,
        lon: (this.lineEnds[0].lon + this.lineEnds[1].lon) / 2,
      };
    }
    if (this.lineEnds.length === 1) return { ...this.lineEnds[0] };
    const sf = this.pack.marks.find(m => m.kind === 'line');
    return sf && sf.lat != null ? { lat: sf.lat, lon: sf.lon } : null;
  }

  /**
   * Position of a mark, resolving the ones that only exist on the day:
   * the laid clearance buoy sits upwind of the start line, so it needs the
   * wind direction before it can be placed at all.
   */
  posOf(id) {
    const m = this.markById(id);
    if (!m) return null;
    if (m.kind === 'line') return this.startPos();
    if (m.lat != null) return { lat: m.lat, lon: m.lon };
    if (m.id === 'X' && this.windFrom != null) {
      const s = this.startPos();
      return s ? movePt(s, this.windFrom, 0.8) : null;
    }
    return null;
  }

  /**
   * Resolve the built course into the waypoint list actually sailed.
   * Unplaceable marks (laid marks with no position yet) are included but
   * flagged, so the leg list shows them without breaking the chart.
   */
  sequence() {
    const seq = [];
    const sf = this.pack.marks.find(m => m.kind === 'line');
    const startPos = this.startPos();
    seq.push({
      id: sf ? sf.id : 'SF', label: 'Start', role: 'start', side: null,
      pos: startPos, kind: 'line',
    });

    for (const leg of this.legs) {
      if (leg.side === 'G' && leg.gate) {
        const members = leg.gate.map(id => ({ id, pos: this.posOf(id), mark: this.markById(id) }));
        seq.push({
          id: leg.gate.join('|'), label: leg.gate.join(' / '), role: 'gate', side: 'G',
          gate: members, pos: members.find(m => m.pos) ? members.find(m => m.pos).pos : null,
          kind: 'gate',
        });
        continue;
      }
      const m = this.markById(leg.markId);
      if (!m) continue;
      const pos = this.posOf(leg.markId);
      seq.push({
        id: m.id,
        label: m.name,
        role: 'mark',
        side: leg.side || this.pack.rules.default_rounding || 'P',
        pos,
        quadrants: m.quadrants || null,
        kind: m.kind || 'course',
        local: !!m.local,
        unplaced: pos == null,
      });
    }

    seq.push({
      id: sf ? sf.id : 'SF', label: 'Finish', role: 'finish', side: null,
      pos: startPos, kind: 'line',
    });
    return seq;
  }

  /** Bearing of the leg arriving at waypoint i, used to pick the quadrant. */
  legBearing(seq, i) {
    if (i <= 0 || i >= seq.length) return null;
    const a = seq[i - 1].pos, b = seq[i].pos;
    if (!a || !b) return null;
    return brgTo(a, b);
  }

  /** Straight-line length of the whole course in nm, skipping unplaced marks. */
  lengthNm() {
    const pts = this.sequence().map(w => w.pos).filter(Boolean);
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += distNm(pts[i - 1], pts[i]);
    return d;
  }
}

/**
 * Decides when a waypoint has been passed.
 *
 * Three mechanisms, in order of authority:
 *
 *  quadrant  SI 10.7 — a valid fix inside the mark's published 90 degree
 *            quadrant. This is what the SIs actually define, so where a
 *            quadrant exists it is the test used.
 *  line      A start or finish line with both ends pinged is a real line, so
 *            crossing it is detected as a crossing, not as proximity.
 *  proximity Fallback for marks with no published quadrant.
 *
 * Nothing here ever advances the course without recording why, and a missed
 * rounding is always recoverable by hand — see `advance`.
 */
export class RoundingEngine {
  constructor(course) {
    this.course = course;
    this.wpIdx = 1;                 // 0 is the start; 1 is the first mark
    this.events = [];               // {wpIdx, id, label, how, at, fix, quad}
    this.startedAt = null;
    this.finishedAt = null;
  }

  state() {
    return {
      wpIdx: this.wpIdx, events: this.events,
      startedAt: this.startedAt, finishedAt: this.finishedAt,
    };
  }

  restore(s) {
    if (!s) return;
    this.wpIdx = s.wpIdx != null ? s.wpIdx : 1;
    this.events = s.events || [];
    this.startedAt = s.startedAt || null;
    this.finishedAt = s.finishedAt || null;
  }

  get seq() { return this.course.sequence(); }

  current() {
    const s = this.seq;
    return this.wpIdx < s.length ? s[this.wpIdx] : null;
  }

  done() {
    return this.wpIdx >= this.seq.length;
  }

  /** The quadrant that applies to the waypoint we are heading for. */
  currentQuadrant() {
    const s = this.seq, wp = s[this.wpIdx];
    if (!wp || !wp.quadrants || !wp.pos) return null;
    const quad = pickQuadrant(wp.quadrants, this.course.legBearing(s, this.wpIdx));
    return quad ? { pos: wp.pos, quad, radiusNm: QUAD_NM } : null;
  }

  /**
   * Feed a fix in. Returns a list of events that just happened.
   * `prev` is the previous fix, needed for line crossing.
   */
  step(fix, prev, nowMs) {
    const out = [];
    if (this.done()) return out;
    const s = this.seq;
    const wp = s[this.wpIdx];
    if (!wp) return out;

    // The start line: only once racing has begun.
    if (wp.role === 'start') return out;

    if (wp.role === 'finish') {
      // Report the mechanism honestly: "line" only when both ends were pinned
      // and the boat actually crossed between them. With a single published
      // position it is a proximity hit, and a finish time derived that way is
      // not evidence of crossing a line.
      const how = this.crossedLine(fix, prev, wp);
      if (how) {
        out.push(this.record(wp, how, fix, nowMs, null, FLAG_FINISH));
        this.finishedAt = nowMs;
      }
      return out;
    }

    if (wp.role === 'gate' && wp.gate) {
      for (const g of wp.gate) {
        if (g.pos && distNm(g.pos, fix) < PROX_NM) {
          out.push(this.record(wp, 'proximity', fix, nowMs, null, FLAG_ROUNDED, g.id));
          return out;
        }
      }
      return out;
    }

    if (!wp.pos) return out;      // mark has no position yet; nothing to test

    const quad = pickQuadrant(wp.quadrants, this.course.legBearing(s, this.wpIdx));
    if (quad) {
      if (inQuadrant(wp.pos, fix, quad, QUAD_NM)) {
        out.push(this.record(wp, 'quadrant', fix, nowMs, quad, FLAG_ROUNDED));
      }
      return out;
    }

    if (distNm(wp.pos, fix) < PROX_NM) {
      out.push(this.record(wp, 'proximity', fix, nowMs, null, FLAG_ROUNDED));
    }
    return out;
  }

  /** Returns 'line', 'proximity', or null — the mechanism that fired, if any. */
  crossedLine(fix, prev, wp) {
    const ends = this.course.lineEnds;
    if (ends.length === 2 && prev) {
      return crossesLine(prev, fix, ends[0], ends[1]) ? 'line' : null;
    }
    if (wp.pos && distNm(wp.pos, fix) < PROX_NM) return 'proximity';
    return null;
  }

  record(wp, how, fix, nowMs, quad, flag, gateId) {
    const ev = {
      wpIdx: this.wpIdx,
      id: gateId || wp.id,
      label: gateId ? `${wp.label} (${gateId})` : wp.label,
      side: wp.side,
      how,
      at: nowMs,
      fix: { lat: fix.lat, lon: fix.lon, acc: fix.acc == null ? null : fix.acc },
      quad: quad ? { b1: quad.b1, b2: quad.b2, si: quad.si || null } : null,
      flag: flag || 0,
    };
    this.events.push(ev);
    this.wpIdx++;
    return ev;
  }

  /**
   * Move the course on (or back) by hand.
   *
   * This exists because a mark can be off station, a fix can drop out at
   * exactly the wrong moment, or the RC can shift a mark mid-race — and none
   * of that should leave the course stuck for the rest of the day. The track
   * keeps recording either way.
   */
  advance(dir, fix, nowMs, reason) {
    const s = this.seq;
    if (dir > 0) {
      if (this.wpIdx >= s.length) return null;
      const wp = s[this.wpIdx];
      const ev = {
        wpIdx: this.wpIdx, id: wp.id, label: wp.label, side: wp.side,
        how: 'manual', at: nowMs,
        fix: fix ? { lat: fix.lat, lon: fix.lon, acc: fix.acc == null ? null : fix.acc } : null,
        quad: null, flag: FLAG_MANUAL, reason: reason || null,
      };
      this.events.push(ev);
      this.wpIdx++;
      if (wp.role === 'finish') this.finishedAt = nowMs;
      return ev;
    }
    if (this.wpIdx <= 1) return null;
    this.wpIdx--;
    // drop the event for the waypoint we just stepped back onto
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].wpIdx === this.wpIdx) { this.events.splice(i, 1); break; }
    }
    this.finishedAt = null;
    return null;
  }
}

/**
 * The SI 20.8 rounding declaration.
 *
 * "within 15 minutes of rounding or passing a Waypoint Mark, notify the Race
 *  Officer via text/mms ... providing: The Yacht's Name AND Photograph of an
 *  instrument displaying the fix and time of the Rounding or Passing the
 *  Waypoint Mark within the Rounding Quadrant"
 *
 * This builds exactly that: the yacht, the mark, the fix, the time, and the
 * quadrant the fix fell in — as text for the message and as fields for the
 * image the app renders.
 */
export function declaration(ev, opts = {}) {
  const yacht = opts.yacht || '';
  const sail = opts.sail || '';
  const when = new Date(ev.at);
  const pos = ev.fix ? fmtDDM(ev.fix.lat, ev.fix.lon) : '—';
  const hhmmss = when.toTimeString().slice(0, 8);
  let quadLine = null;
  if (ev.quad) {
    const [from, to] = quadrantArc(ev.quad.b1, ev.quad.b2);
    const brg = ev.fix ? brgTo({ lat: opts.markLat, lon: opts.markLon }, ev.fix) : null;
    quadLine = `Quadrant ${fmtBrg(from)}–${fmtBrg(to)}` +
      (brg != null && isFinite(brg) ? ` · fix bore ${fmtBrg(brg)} from the mark` : '');
  }
  const lines = [
    yacht ? `${yacht}${sail ? ' (' + sail + ')' : ''}` : '(set your yacht name in Settings)',
    `${ev.label}${ev.side ? ' to ' + (ev.side === 'P' ? 'port' : ev.side === 'S' ? 'starboard' : ev.side) : ''}`,
    `Fix ${pos}`,
    `Time ${hhmmss}`,
  ];
  if (quadLine) lines.push(quadLine);
  if (ev.how === 'manual') lines.push('Advanced manually — not a quadrant fix');
  if (ev.fix && ev.fix.acc != null) lines.push(`GPS accuracy ±${Math.round(ev.fix.acc)} m`);
  return {
    text: lines.join('\n'),
    lines,
    deadline: ev.at + (opts.windowMin || 15) * 60000,
    valid: ev.how === 'quadrant',
  };
}

/** Marks sorted by how close they are — what the builder offers first. */
export function nearestMarks(course, from, limit = 99) {
  const out = course.allMarks()
    .filter(m => m.kind !== 'line')
    .map(m => {
      const pos = course.posOf(m.id);
      return { mark: m, pos, nm: pos && from ? distNm(from, pos) : null };
    });
  out.sort((a, b) => {
    if (a.nm == null && b.nm == null) return 0;
    if (a.nm == null) return 1;
    if (b.nm == null) return -1;
    return a.nm - b.nm;
  });
  return out.slice(0, limit);
}

/** Is a mark off station per SI 10.3? Returns metres off, or null. */
export function offStation(course, markId, observed) {
  const pos = course.posOf(markId);
  if (!pos || !observed) return null;
  const m = distM(pos, observed);
  const limit = (course.pack.rules && course.pack.rules.off_station_m) || 200;
  return { metres: m, offStation: m > limit, limit };
}
