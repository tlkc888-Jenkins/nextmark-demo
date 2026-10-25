// Coastline for anywhere on earth.
//
// Two layers, because a race chart needs both coverage and detail:
//
//  world  A generalised global coastline (Natural Earth 10m, public domain),
//         tiled into 10 degree cells and stored as encoded polylines. About
//         1 MB for the whole planet, cached once by the service worker, so the
//         chart is never blank no matter where the marks are. Median vertex
//         spacing is around 1.5 km — orientation, not detail.
//
//  pack   A high-detail coastline clipped to one race area and shipped with
//         that course pack (OpenStreetMap, ~25 m). Drawn in preference to the
//         world layer wherever it covers the view.
//
// Neither is for navigation and the app says so.

const cache = { world: null, worldDecoded: new Map(), packs: new Map() };

/** Google encoded polyline -> [[lat, lon], ...] */
export function decodePolyline(str, precision = 4) {
  const f = Math.pow(10, precision);
  const out = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    let r = 0, sh = 0, b;
    do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
    lat += (r & 1) ? ~(r >> 1) : (r >> 1);
    r = 0; sh = 0;
    do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20);
    lon += (r & 1) ? ~(r >> 1) : (r >> 1);
    out.push([lat / f, lon / f]);
  }
  return out;
}

export async function loadWorld(url = 'data/coast-world.json') {
  if (cache.world) return cache.world;
  const res = await fetch(url);
  if (!res.ok) throw new Error('coastline unavailable (' + res.status + ')');
  cache.world = await res.json();
  return cache.world;
}

export async function loadPackCoast(id, url) {
  if (cache.packs.has(id)) return cache.packs.get(id);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const doc = await res.json();
    const lines = doc.lines.map(s => decodePolyline(s, doc.precision || 4));
    const entry = { lines, attribution: doc.attribution || doc.source || '' };
    cache.packs.set(id, entry);
    return entry;
  } catch {
    cache.packs.set(id, null);
    return null;
  }
}

function tileKey(lonCell, latCell) {
  return `${lonCell}_${latCell}`;
}

/** Decode (once) and return the lines for one world tile. */
function worldTile(doc, key) {
  if (cache.worldDecoded.has(key)) return cache.worldDecoded.get(key);
  const enc = doc.tiles[key];
  const lines = enc ? enc.map(s => decodePolyline(s, doc.precision || 4)) : [];
  cache.worldDecoded.set(key, lines);
  return lines;
}

/**
 * Coastline lines overlapping an extent.
 *
 * The world layer keeps a crossing segment in both of the cells it spans, but a
 * single generalised segment can still jump several cells in the open ocean, so
 * we take a one-cell ring around the view rather than only the cells it covers.
 */
export function worldLinesFor(doc, ext) {
  if (!doc) return [];
  const t = doc.tile_deg || 10;
  const c = v => Math.floor(v / t) * t;
  const lo0 = c(ext.lon0) - t, lo1 = c(ext.lon1) + t;
  const la0 = c(ext.lat0) - t, la1 = c(ext.lat1) + t;
  const out = [];
  for (let lo = lo0; lo <= lo1; lo += t) {
    for (let la = la0; la <= la1; la += t) {
      // wrap longitude so a view across the antimeridian still finds its cells
      const loW = ((lo + 180) % 360 + 360) % 360 - 180;
      for (const l of worldTile(doc, tileKey(loW, la))) out.push(l);
    }
  }
  return out;
}

/** Does a high-detail pack coastline actually cover this extent? */
export function packCovers(pack, ext) {
  if (!pack || !pack.lines.length) return false;
  for (const l of pack.lines) {
    for (const [la, lo] of l) {
      if (la >= ext.lat0 && la <= ext.lat1 && lo >= ext.lon0 && lo <= ext.lon1) return true;
    }
  }
  return false;
}

/** Clip lines to an extent with a margin, dropping runs entirely outside it. */
export function clipLines(lines, ext, marginDeg = 0.5) {
  const la0 = ext.lat0 - marginDeg, la1 = ext.lat1 + marginDeg;
  const lo0 = ext.lon0 - marginDeg, lo1 = ext.lon1 + marginDeg;
  const inside = ([la, lo]) => la >= la0 && la <= la1 && lo >= lo0 && lo <= lo1;
  const out = [];
  for (const l of lines) {
    let run = null;
    for (let i = 0; i < l.length; i++) {
      const here = inside(l[i]);
      // keep one vertex either side so lines reach the edge of the view
      const near = here || (i > 0 && inside(l[i - 1])) || (i + 1 < l.length && inside(l[i + 1]));
      if (near) { (run || (run = [])).push(l[i]); }
      else if (run) { if (run.length > 1) out.push(run); run = null; }
    }
    if (run && run.length > 1) out.push(run);
  }
  return out;
}
