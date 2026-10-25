// On-device storage for NextMark.
//
// Everything a race produces lives on the device that recorded it. Nothing is
// uploaded. The design target is a 6-hour passage race (the SI race time limit)
// recorded at 1 Hz, surviving a screen lock, a reload, a crash or a flat
// battery with at most a few seconds of track lost.
//
// Track codec — 20 bytes per fix:
//   int32   lat     degrees * 1e7      (1.1 cm resolution)
//   int32   lon     degrees * 1e7
//   uint32  dt      ms since race start (49 days of range)
//   uint16  sog     knots * 100
//   uint16  cog     degrees * 10
//   uint16  acc     GPS accuracy in metres, capped
//   uint16  flags   see FLAG_*
//
// That is 72 KB per hour at 1 Hz, so a 6-hour passage race is about 430 KB and
// a full 15-day Offshore season a handful of megabytes. Fixes are appended into
// fixed-size chunks; the open chunk is rewritten on a short interval so a hard
// kill costs seconds, not the race.

export const FIX_BYTES = 20;
export const CHUNK_FIXES = 512;              // 10.24 KB per chunk
export const FLUSH_MS = 5000;                // worst-case loss on a hard kill

export const FLAG_RESUME = 1 << 0;           // first fix after a gap in recording
export const FLAG_ROUNDED = 1 << 1;          // auto rounding fired on this fix
export const FLAG_MANUAL = 1 << 2;           // mark advanced by hand
export const FLAG_START = 1 << 3;            // start signal
export const FLAG_FINISH = 1 << 4;           // finish line crossed

const DB_NAME = 'nextmark';
const DB_VERSION = 1;

// ---------------------------------------------------------------------------
// codec
// ---------------------------------------------------------------------------

export function encodeFix(view, i, f) {
  const o = i * FIX_BYTES;
  view.setInt32(o, Math.round(f.lat * 1e7));
  view.setInt32(o + 4, Math.round(f.lon * 1e7));
  view.setUint32(o + 8, Math.max(0, Math.min(0xffffffff, Math.round(f.dt))));
  view.setUint16(o + 12, Math.max(0, Math.min(65535, Math.round((f.sog || 0) * 100))));
  view.setUint16(o + 14, Math.max(0, Math.min(65535, Math.round((f.cog || 0) * 10))));
  view.setUint16(o + 16, Math.max(0, Math.min(65535, Math.round(f.acc == null ? 65535 : f.acc))));
  view.setUint16(o + 18, f.flags || 0);
}

export function decodeFix(view, i) {
  const o = i * FIX_BYTES;
  const acc = view.getUint16(o + 16);
  return {
    lat: view.getInt32(o) / 1e7,
    lon: view.getInt32(o + 4) / 1e7,
    dt: view.getUint32(o + 8),
    sog: view.getUint16(o + 12) / 100,
    cog: view.getUint16(o + 14) / 10,
    acc: acc === 65535 ? null : acc,
    flags: view.getUint16(o + 18),
  };
}

export function decodeChunk(buf, n) {
  const view = new DataView(buf);
  const count = n != null ? n : Math.floor(buf.byteLength / FIX_BYTES);
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = decodeFix(view, i);
  return out;
}

// ---------------------------------------------------------------------------
// IndexedDB plumbing
// ---------------------------------------------------------------------------

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('races')) {
        const s = db.createObjectStore('races', { keyPath: 'id' });
        s.createIndex('startedAt', 'startedAt');
        s.createIndex('status', 'status');
      }
      if (!db.objectStoreNames.contains('chunks')) {
        db.createObjectStore('chunks', { keyPath: ['raceId', 'seq'] });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'k' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    try { result = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  }));
}

const wrap = req => ({ __req: req });

/** Is on-device storage usable at all? */
export async function available() {
  try { await openDb(); return true; } catch { return false; }
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

export async function getSetting(k, dflt) {
  try {
    const v = await tx('settings', 'readonly', s => wrap(s.get(k)));
    return v === undefined ? dflt : v.v;
  } catch { return dflt; }
}

export async function setSetting(k, v) {
  try { await tx('settings', 'readwrite', s => s.put({ k, v })); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// races
// ---------------------------------------------------------------------------

export async function putRace(race) {
  return tx('races', 'readwrite', s => s.put(race));
}

export async function getRace(id) {
  return tx('races', 'readonly', s => wrap(s.get(id)));
}

export async function listRaces() {
  const all = await tx('races', 'readonly', s => wrap(s.getAll()));
  return (all || []).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

/** The race that was still being recorded when we last stopped, if any. */
export async function findLiveRace() {
  const all = await listRaces();
  return all.find(r => r.status === 'live') || null;
}

export async function deleteRace(id) {
  await tx('races', 'readwrite', s => s.delete(id));
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const t = db.transaction('chunks', 'readwrite');
    // every chunk for this race, regardless of seq
    const range = IDBKeyRange.bound([id, -Infinity], [id, Infinity]);
    const req = t.objectStore('chunks').openCursor(range);
    req.onsuccess = () => {
      const c = req.result;
      if (c) { c.delete(); c.continue(); }
    };
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

/** Total bytes of track stored for one race. */
export async function trackBytes(raceId) {
  const chunks = await loadChunks(raceId);
  return chunks.reduce((n, c) => n + (c.buf ? c.buf.byteLength : 0), 0);
}

async function loadChunks(raceId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('chunks', 'readonly');
    const range = IDBKeyRange.bound([raceId, -Infinity], [raceId, Infinity]);
    const req = t.objectStore('chunks').getAll(range);
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.seq - b.seq));
    req.onerror = () => reject(req.error);
  });
}

/** Decode a whole race track back into fix objects. */
export async function loadTrack(raceId) {
  const chunks = await loadChunks(raceId);
  const out = [];
  for (const c of chunks) {
    if (!c.buf) continue;
    for (const f of decodeChunk(c.buf, c.n)) out.push(f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// TrackRecorder — buffers fixes and flushes the open chunk on an interval
// ---------------------------------------------------------------------------

export class TrackRecorder {
  constructor(raceId, startedAt, opts = {}) {
    this.raceId = raceId;
    this.startedAt = startedAt;
    this.flushMs = opts.flushMs || FLUSH_MS;
    this.seq = 0;
    this.n = 0;                                      // fixes in the open chunk
    this.count = 0;                                  // fixes in the whole race
    this.buf = new ArrayBuffer(CHUNK_FIXES * FIX_BYTES);
    this.view = new DataView(this.buf);
    this.dirty = false;
    this.lastFlush = 0;
    this.onError = opts.onError || (() => {});
  }

  /** Resume recording into an existing race's track. */
  static async resume(raceId, startedAt, opts) {
    const r = new TrackRecorder(raceId, startedAt, opts);
    const chunks = await loadChunks(raceId);
    r.count = chunks.reduce((n, c) => n + (c.n || 0), 0);
    const last = chunks[chunks.length - 1];
    if (last && (last.n || 0) < CHUNK_FIXES) {
      // reopen the last partial chunk so we keep appending into it
      r.seq = last.seq;
      r.n = last.n || 0;
      new Uint8Array(r.buf).set(new Uint8Array(last.buf).subarray(0, r.n * FIX_BYTES));
    } else if (last) {
      r.seq = last.seq + 1;
    }
    return r;
  }

  /** Append one fix. Returns true if a flush is due. */
  add(fix, nowMs) {
    encodeFix(this.view, this.n, fix);
    this.n++;
    this.count++;
    this.dirty = true;
    if (this.n >= CHUNK_FIXES) { this.flush(nowMs); return true; }
    if (nowMs - this.lastFlush >= this.flushMs) { this.flush(nowMs); return true; }
    return false;
  }

  /** Persist the open chunk. Rolls to a new chunk once this one is full. */
  flush(nowMs) {
    if (!this.dirty || this.n === 0) return Promise.resolve();
    const seq = this.seq, n = this.n;
    const copy = this.buf.slice(0, n * FIX_BYTES);
    this.dirty = false;
    this.lastFlush = nowMs == null ? this.lastFlush : nowMs;
    if (n >= CHUNK_FIXES) {
      this.seq = seq + 1;
      this.n = 0;
      this.buf = new ArrayBuffer(CHUNK_FIXES * FIX_BYTES);
      this.view = new DataView(this.buf);
    }
    return tx('chunks', 'readwrite', s => s.put({ raceId: this.raceId, seq, n, buf: copy }))
      .catch(e => { this.onError(e); });
  }

  bytes() {
    return this.count * FIX_BYTES;
  }
}

// ---------------------------------------------------------------------------
// storage budget — reported from the browser, never guessed
// ---------------------------------------------------------------------------

/**
 * What the device actually says about storage, plus what that means in races.
 * `usage`/`quota` are bytes and may be absent on older browsers.
 */
export async function storageInfo() {
  const info = {
    usage: null, quota: null, persisted: false, canPersist: false,
    bytesPerHour: FIX_BYTES * 3600,              // 72 KB at 1 Hz
  };
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      info.usage = e.usage ?? null;
      info.quota = e.quota ?? null;
    }
    if (navigator.storage && navigator.storage.persisted) {
      info.persisted = await navigator.storage.persisted();
      info.canPersist = typeof navigator.storage.persist === 'function';
    }
  } catch { /* leave the nulls — better than a made-up number */ }
  if (info.quota != null && info.usage != null) {
    info.freeHours = Math.max(0, info.quota - info.usage) / info.bytesPerHour;
  }
  return info;
}

/**
 * Ask the browser to exempt this origin from storage eviction. Chrome grants
 * this to installed apps; Safari does not implement it, which is why the app
 * tells the user to add it to the Home Screen instead.
 */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch { /* ignore */ }
  return false;
}

export function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export function newId() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'r' + Date.now().toString(36);
}
