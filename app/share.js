// Sharing a course to the crew.
//
// The helm builds the course once from the board and sends a link to the group
// chat. The whole course rides inside the link, so there is no server, no
// accounts and nothing to provision for eight phones.
//
// Three things this has to get right:
//
//  1. It goes in the URL *fragment*, never the query string. A fragment is
//     never sent to the host, so the course does not end up in anyone's logs.
//  2. A mangled link must fail loudly. Chat apps wrap, truncate and append to
//     URLs; a half-decoded course that still parses would put the wrong marks
//     on someone's chart, which is far worse than an error message. Hence the
//     checksum.
//  3. Nothing is applied on arrival. The link opens a confirmation showing the
//     course in full; the crew member taps to load it.

const VERSION = 1;

// ---------------------------------------------------------------------------
// base64url over UTF-8 — works in the browser and in node
// ---------------------------------------------------------------------------

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** FNV-1a, base36. Short enough to keep the link tidy, enough to catch damage. */
export function checksum(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0').slice(-7);
}

// ---------------------------------------------------------------------------
// encode
// ---------------------------------------------------------------------------

/**
 * Pack a course into a link fragment.
 *
 * Marks added on the water travel with it — without them the legs that
 * reference them would not resolve on the crew's phone.
 */
export function encodeCourse(course, opts = {}) {
  const payload = {
    v: VERSION,
    p: course.pack.id,
    c: course.courseId,
    d: course.division,
    l: course.legs.map(leg => [leg.markId, leg.side || 'P']),
  };
  if (opts.name) payload.n = String(opts.name).slice(0, 80);
  if (course.localMarks.length) {
    payload.m = course.localMarks.map(m => [
      m.id, m.name || '', round7(m.lat), round7(m.lon),
    ]);
  }
  if (course.lineEnds.length) {
    payload.e = course.lineEnds.map(p => [round7(p.lat), round7(p.lon)]);
  }
  if (course.windFrom != null) payload.w = Math.round(course.windFrom);
  if (course.startId) payload.s = course.startId;
  if (course.finishId) payload.f = course.finishId;
  if (opts.crew) payload.k = 'crew';

  const json = JSON.stringify(payload);
  const body = b64urlEncode(json);
  return body + '.' + checksum(body);
}

function round7(v) {
  return Math.round(v * 1e7) / 1e7;
}

/** The full link to send. */
export function courseLink(course, opts = {}) {
  const base = (opts.baseUrl || defaultBase()).split('#')[0];
  return base + '#c=' + encodeCourse(course, opts);
}

function defaultBase() {
  if (typeof location === 'undefined') return '';
  return location.origin + location.pathname;
}

// ---------------------------------------------------------------------------
// decode
// ---------------------------------------------------------------------------

/**
 * Read a shared course out of a link.
 * Returns {ok, data} or {ok:false, error} — never a partially-trusted course.
 */
export function decodeCourse(fragment) {
  if (!fragment) return { ok: false, error: 'No course in that link.' };
  let raw = String(fragment).trim();
  if (raw.startsWith('#')) raw = raw.slice(1);
  const m = raw.match(/(?:^|[&?])c=([^&]+)/);
  if (m) raw = m[1];

  // Chat clients love to append punctuation to a URL.
  raw = raw.replace(/[).,;'"\]]+$/, '');

  const dot = raw.lastIndexOf('.');
  if (dot < 1) {
    return { ok: false, error: 'That course link looks incomplete — ask for it to be sent again.' };
  }
  const body = raw.slice(0, dot);
  const sum = raw.slice(dot + 1);
  if (checksum(body) !== sum) {
    return {
      ok: false,
      error: 'That course link arrived damaged — the chat app may have cut it short. Ask for it again.',
    };
  }

  let json, data;
  try { json = b64urlDecode(body); } catch {
    return { ok: false, error: 'That course link could not be read.' };
  }
  try { data = JSON.parse(json); } catch {
    return { ok: false, error: 'That course link could not be read.' };
  }
  if (!data || typeof data !== 'object') {
    return { ok: false, error: 'That course link could not be read.' };
  }
  if (data.v !== VERSION) {
    return {
      ok: false,
      error: `That link was made by a different version of the app (v${data.v}). Update and try again.`,
    };
  }
  if (!Array.isArray(data.l)) {
    return { ok: false, error: 'That link has no course in it.' };
  }
  return { ok: true, data };
}

/**
 * Check a decoded course against the loaded pack and turn it into something
 * reviewable. Anything that does not resolve becomes a visible problem.
 */
export function toSharedProposal(data, course) {
  const out = {
    name: data.n || '',
    courseId: data.c || 'X1',
    division: data.d || null,
    crew: data.k === 'crew',
    wind: data.w == null ? null : data.w,
    startId: null,
    finishId: null,
    legs: [],
    localMarks: [],
    lineEnds: [],
    problems: [],
    packMismatch: false,
  };

  if (data.p && data.p !== course.pack.id) {
    out.packMismatch = true;
    out.problems.push(
      `That course is for a different club pack (${data.p}). This app has ${course.pack.id} loaded.`);
    return out;
  }

  for (const lm of data.m || []) {
    const [id, name, lat, lon] = lm;
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      out.problems.push(`Shared mark "${id}" has an impossible position and was dropped.`);
      continue;
    }
    out.localMarks.push({ id: String(id), name: String(name || id), lat, lon });
  }

  const known = new Set([
    ...course.allMarks().map(m => m.id),
    ...out.localMarks.map(m => m.id),
  ]);
  for (const leg of data.l) {
    const id = Array.isArray(leg) ? leg[0] : leg.markId;
    const side = (Array.isArray(leg) ? leg[1] : leg.side) === 'S' ? 'S' : 'P';
    if (!known.has(id)) { out.problems.push(`Shared course refers to "${id}", which is not a known mark.`); continue; }
    out.legs.push({ markId: id, side });
  }
  if (!out.legs.length) out.problems.push('No usable marks in that shared course.');

  for (const e of data.e || []) {
    if (Array.isArray(e) && isFinite(e[0]) && isFinite(e[1])) out.lineEnds.push({ lat: e[0], lon: e[1] });
  }

  // Start and finish lines must resolve to published line marks, or the crew's
  // chart would invent a line the pack does not have.
  const lines = new Set(course.pack.marks.filter(m => m.kind === 'line').map(m => m.id));
  for (const [key, field] of [['s', 'startId'], ['f', 'finishId']]) {
    if (data[key] == null) continue;
    if (lines.has(data[key])) out[field] = String(data[key]);
    else out.problems.push(`Shared course ${field === 'startId' ? 'starts' : 'finishes'} on "${data[key]}", which is not a published line.`);
  }
  return out;
}

/** Put a reviewed shared course onto the given Course. */
export function applySharedCourse(course, prop) {
  for (const m of prop.localMarks) {
    if (course.markById(m.id)) continue;
    course.localMarks.push({
      id: m.id, name: m.name, lat: m.lat, lon: m.lon, kind: 'course',
      note: 'Shared by the helm — verify against the board.',
      addedAt: Date.now(),
    });
  }
  course.courseId = prop.courseId;
  if (prop.division) course.division = prop.division;
  if (prop.wind != null) course.windFrom = prop.wind;
  course.startId = prop.startId || null;
  course.finishId = prop.finishId || null;
  course.lineEnds = prop.lineEnds.map(p => ({ ...p }));
  course.legs = prop.legs.map(l => ({ ...l }));
  return { ok: true, count: course.legs.length };
}
