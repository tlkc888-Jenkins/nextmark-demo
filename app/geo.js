// Geometry and coordinate handling for NextMark.
// Pure functions, no DOM — so they can be unit tested outside the browser.

export const R_NM = 3440.065;      // mean earth radius in nautical miles
export const R_M = 6371008.8;      // mean earth radius in metres
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

/** Great-circle distance in nautical miles. */
export function distNm(a, b) {
  const dLat = (b.lat - a.lat) * D2R, dLon = (b.lon - a.lon) * D2R;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Great-circle distance in metres. */
export function distM(a, b) {
  return distNm(a, b) / R_NM * R_M;
}

/** Initial great-circle bearing a -> b, degrees true, 0..360. */
export function brgTo(a, b) {
  const dLon = (b.lon - a.lon) * D2R;
  const y = Math.sin(dLon) * Math.cos(b.lat * D2R);
  const x = Math.cos(a.lat * D2R) * Math.sin(b.lat * D2R) -
    Math.sin(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.cos(dLon);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

/** Move a point along a bearing by a distance in nautical miles. */
export function movePt(p, brgDeg, dNm) {
  const br = brgDeg * D2R, dr = dNm / R_NM, la1 = p.lat * D2R, lo1 = p.lon * D2R;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(dr) + Math.cos(la1) * Math.sin(dr) * Math.cos(br));
  const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(dr) * Math.cos(la1),
    Math.cos(dr) - Math.sin(la1) * Math.sin(la2));
  return { lat: la2 * R2D, lon: ((lo2 * R2D + 540) % 360) - 180 };
}

/** Clockwise angular span from b1 to b2, 0..360. */
export function arcSpan(b1, b2) {
  return ((b2 - b1) % 360 + 360) % 360;
}

/** Smallest absolute difference between two bearings, 0..180. */
export function brgDiff(b1, b2) {
  const d = Math.abs(((b1 - b2) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}

// ---------------------------------------------------------------------------
// SI 10.7 rounding quadrants
//
// "Rounding or Passing Waypoint Marks have an associated rounding quadrant
//  defined as the area enclosed between the two bearing lines (with 90 degrees
//  between them) extending from the waypoint. A boat that provides a valid GPS
//  fix within this quadrant is deemed to have rounded or passed the Waypoint
//  Mark on the correct side."
//
// The SI writes the pair loosely ("0 and 270"), so we resolve whichever
// ordering spans 90 degrees clockwise rather than trusting the written order.
// ---------------------------------------------------------------------------

/** Resolve a loose bearing pair into a clockwise [from, to] 90 degree arc. */
export function quadrantArc(b1, b2) {
  const f1 = ((b1 % 360) + 360) % 360, f2 = ((b2 % 360) + 360) % 360;
  return Math.abs(arcSpan(f1, f2) - 90) < 1e-6 ? [f1, f2] : [f2, f1];
}

/** Is bearing b inside the clockwise arc from->to? */
export function inArc(b, from, to) {
  const span = arcSpan(from, to);
  return arcSpan(from, b) <= span + 1e-9;
}

/**
 * Choose which of a mark's quadrants applies, given the bearing of the leg
 * arriving at that mark. Quadrants tagged "*" apply in any direction;
 * otherwise "S" is used for a southerly leg (bearing 90..270) and "N" for a
 * northerly one. Returns null when the mark has no published quadrant.
 */
export function pickQuadrant(quadrants, legBrg) {
  if (!quadrants || !quadrants.length) return null;
  const any = quadrants.find(q => q.dir === '*');
  if (any) return any;
  if (legBrg == null) return null;
  const southerly = legBrg > 90 && legBrg < 270;
  return quadrants.find(q => q.dir === (southerly ? 'S' : 'N')) || null;
}

/**
 * Has the boat produced a valid fix inside the mark's rounding quadrant?
 * `markPos` is the mark, `fix` the boat position, `quad` one entry from the
 * mark's quadrant list. Within `withinNm` of the mark only, so a fix on the
 * same bearing but miles away does not count as a rounding.
 */
export function inQuadrant(markPos, fix, quad, withinNm) {
  if (!quad) return false;
  const d = distNm(markPos, fix);
  if (withinNm != null && d > withinNm) return false;
  const [from, to] = quadrantArc(quad.b1, quad.b2);
  return inArc(brgTo(markPos, fix), from, to);
}

// ---------------------------------------------------------------------------
// Line crossing — for a real start/finish line between two pinged ends
// ---------------------------------------------------------------------------

/**
 * Did the boat's travel from `p0` to `p1` cross the line segment `a`-`b`?
 * Works in a local flat projection, which is exact enough over the few metres
 * between consecutive GPS fixes. Returns null for no crossing, otherwise
 * {t, side} where t is 0..1 along the boat's travel and side is the sign of
 * the crossing direction (so a finish only counts the right way).
 */
export function crossesLine(p0, p1, a, b) {
  const lat0 = (a.lat + b.lat) / 2;
  const kx = Math.cos(lat0 * D2R);
  const X = p => [(p.lon - a.lon) * kx, p.lat - a.lat];
  const [x0, y0] = X(p0), [x1, y1] = X(p1), [bx, by] = X(b);
  const dx = x1 - x0, dy = y1 - y0;
  const den = dx * (-by) - dy * (-bx);
  if (Math.abs(den) < 1e-15) return null;             // parallel
  const t = ((-x0) * (-by) - (-y0) * (-bx)) / den;    // along boat travel
  const u = (dx * (-y0) - dy * (-x0)) / den;          // along the line a->b
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, side: Math.sign(dx * by - dy * bx) };
}

// ---------------------------------------------------------------------------
// Coordinate parsing and formatting
//
// Accepts the formats a sailor is actually given: the SI / VHF style
// degrees-and-decimal-minutes, plain decimal degrees, and degrees-minutes-
// seconds. Hemisphere may lead or trail; separators are loose because this
// gets typed with cold hands on a moving boat.
// ---------------------------------------------------------------------------

const NUM = '(\\d+(?:[.,]\\d+)?)';

/**
 * Parse one latitude or longitude. Returns a number, or null if unparseable.
 * `axis` is 'lat' or 'lon' and is used to range-check and to resolve a bare
 * signed number.
 */
export function parseOne(str, axis) {
  if (str == null) return null;
  let s = String(str).trim().toUpperCase()
    .replace(/[°º]/g, ' ')                  // degree signs
    .replace(/[′’']/g, ' ')                 // minute marks
    .replace(/[″”"]/g, ' ')                 // second marks
    .replace(/,/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;

  // hemisphere, leading or trailing
  let hemi = null;
  let m = s.match(/^([NSEW])\s*(.*)$/);
  if (m) { hemi = m[1]; s = m[2].trim(); }
  else {
    m = s.match(/^(.*?)\s*([NSEW])$/);
    if (m) { hemi = m[2]; s = m[1].trim(); }
  }
  if (hemi) {
    const wantLat = hemi === 'N' || hemi === 'S';
    if (axis === 'lat' && !wantLat) return null;
    if (axis === 'lon' && wantLat) return null;
  }

  let deg = null;
  if ((m = s.match(new RegExp(`^-?${NUM}\\s+${NUM}\\s+${NUM}$`)))) {
    // D M S
    deg = +m[1] + +m[2] / 60 + +m[3] / 3600;
  } else if ((m = s.match(new RegExp(`^-?${NUM}\\s+${NUM}$`)))) {
    // D M.mmm  — the SI and VHF format
    if (+m[2] >= 60) return null;
    deg = +m[1] + +m[2] / 60;
  } else if ((m = s.match(new RegExp(`^(-)?${NUM}$`)))) {
    deg = +m[2];
  } else {
    return null;
  }

  const neg = /^-/.test(s);
  if (hemi === 'S' || hemi === 'W') deg = -deg;
  else if (!hemi && neg) deg = -deg;

  const lim = axis === 'lat' ? 90 : 180;
  if (!isFinite(deg) || Math.abs(deg) > lim) return null;
  return deg;
}

/**
 * Parse a whole position from one string holding both axes, e.g.
 * "28 11.200 S 153 34.300 E" or "-28.1867, 153.5717".
 * Returns {lat, lon} or null.
 */
export function parsePair(str) {
  if (!str) return null;
  const s = String(str).trim();
  // split on a comma, a slash, or the boundary before the longitude hemisphere
  let parts = null;
  if (/[,;/]/.test(s)) {
    parts = s.split(/[,;/]/, 2);
  } else {
    // "27 56.400 S 153 27.230 E" -> break after the first N/S
    const m = s.match(/^(.*?[NS])\s+(.*)$/i);
    if (m) parts = [m[1], m[2]];
    else {
      // "-27.94 153.4538"
      const t = s.split(/\s+/);
      if (t.length === 2) parts = t;
      else if (t.length === 4) parts = [t.slice(0, 2).join(' '), t.slice(2).join(' ')];
      else if (t.length === 6) parts = [t.slice(0, 3).join(' '), t.slice(3).join(' ')];
    }
  }
  if (!parts || parts.length !== 2) return null;
  let lat = parseOne(parts[0], 'lat');
  let lon = parseOne(parts[1], 'lon');
  if (lat == null || lon == null) {
    // tolerate the two the other way round
    const lat2 = parseOne(parts[1], 'lat'), lon2 = parseOne(parts[0], 'lon');
    if (lat2 == null || lon2 == null) return null;
    lat = lat2; lon = lon2;
  }
  return { lat, lon };
}

/** Format as degrees + decimal minutes, the way the SIs and VHF do. */
export function fmtDDM(lat, lon, dp = 3) {
  const one = (v, pos, neg) => {
    const a = Math.abs(v), d = Math.floor(a);
    const mins = ((a - d) * 60).toFixed(dp).padStart(dp + 3, '0');
    return `${d}°${mins}′${v < 0 ? neg : pos}`;
  };
  if (lon == null) return one(lat, 'N', 'S');
  return `${one(lat, 'N', 'S')} ${one(lon, 'E', 'W')}`;
}

/** Format a bearing as a 3-digit true bearing. */
export function fmtBrg(b) {
  return String(Math.round(((b % 360) + 360) % 360) % 360).padStart(3, '0');
}

/** Velocity made good toward a bearing. */
export function vmc(sog, cog, brg) {
  if (!isFinite(sog) || !isFinite(cog) || !isFinite(brg)) return 0;
  return sog * Math.cos((brg - cog) * D2R);
}
