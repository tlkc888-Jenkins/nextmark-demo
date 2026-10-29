// NextMark — on-water race pilot.
//
// Deck-first: the numbers that matter are always on screen, every control is
// thumb-sized, and nothing except an explicit "new race" can discard a track.

import {
  distNm, brgTo, movePt, fmtBrg, fmtDDM, vmc, parseOne, parsePair, brgDiff, quadrantArc,
} from './geo.js';
import {
  TrackRecorder, listRaces, putRace, getRace, deleteRace, loadTrack, findLiveRace,
  getSetting, setSetting, storageInfo, requestPersistence, fmtBytes, newId, trackBytes,
  FLAG_RESUME, FLAG_ROUNDED, FLAG_MANUAL, FLAG_START, FLAG_FINISH, FIX_BYTES, available,
} from './store.js';
import { Course, RoundingEngine, loadPack, declaration, nearestMarks, offStation, QUAD_NM } from './race.js';
import { Chart, computeExtent, decimate, COL } from './chart.js';
import { loadWorld, loadPackCoast } from './coast.js';
import {
  preparePhoto, blobToDataUrl, readBoard, toProposal, applyProposal, describeLegs,
  readerSettings, saveReaderSettings,
} from './ingest.js';
import { courseLink, decodeCourse, toSharedProposal, applySharedCourse } from './share.js';

const el = id => document.getElementById(id);

// Every series this build ships. The names mirror the packs' own, so the
// switcher can be drawn before either file is fetched.
const PACKS = [
  { id: 'syc-offshore-2627', url: 'data/syc-offshore-2627.json', name: 'SYC Offshore 2026/27' },
  { id: 'syc-twilight-2627', url: 'data/syc-twilight-2627.json', name: 'SYC Thursday Twilight 2026/27' },
];

const S = {
  pack: null,
  course: null,
  engine: null,
  race: null,            // the persisted race record
  recorder: null,
  chart: null,
  world: null,
  packCoast: null,
  fix: null,             // latest position
  prevFix: null,
  track: [],             // in-memory for drawing
  gps: { on: false, watch: null, lastAt: 0, err: null },
  wake: { lock: null, want: false },
  phase: 'idle',         // idle | pre | racing | finished
  gunAt: null,           // absolute ms of the start signal
  targetAt: null,        // absolute ms the countdown is counting to
  follow: false,
  proposal: null,
  photo: null,
  busy: false,
  lastSaveAt: 0,
  crew: false,           // crew mode: follow the helm's course, don't run the start
  incoming: null,        // a shared course waiting to be confirmed
};

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function boot() {
  S.chart = new Chart(el('chart'));

  // A race still recording wins the choice of pack: recovery must put the boat
  // back on the course it was sailing, not the series last browsed.
  let live = null;
  try { live = await findLiveRace(); } catch { /* storage unavailable */ }
  const wanted = (live && live.packId) || await getSetting('pack', PACKS[0].id);
  const packDef = PACKS.find(p => p.id === wanted) || PACKS[0];
  try {
    S.pack = await loadPack(packDef.url);
  } catch (e) {
    fatal('Could not load the course pack. ' + e.message);
    return;
  }
  S.course = new Course(S.pack, { division: await getSetting('division', 'D2') });
  S.engine = new RoundingEngine(S.course);

  // coastline is cosmetic — never block the race screen on it
  loadWorld().then(w => { S.world = w; draw(); }).catch(() => {});
  loadPackCoast(S.pack.id, 'data/coast-syc.json').then(c => { S.packCoast = c; draw(); });

  S.crew = await getSetting('crew', false);

  buildStaticUi();
  await recoverLiveRace(live);
  await refreshStorage();
  renderAll();
  wireEvents();

  // A link from the group chat. Read it, but never apply it on arrival.
  await handleIncomingLink();

  if (!(await available())) {
    warn('This browser is blocking on-device storage, so the track cannot be saved. ' +
      'Open the app from the Home Screen, or turn off private browsing.');
  }
}

function fatal(msg) {
  el('fatal').textContent = msg;
  el('fatal').hidden = false;
}
function warn(msg) {
  const b = el('warnbar');
  b.textContent = msg;
  b.hidden = false;
}
function toast(msg, ms = 4200) {
  const t = el('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------------------------------------------------------------------------
// race lifecycle
// ---------------------------------------------------------------------------

/**
 * A race left recording when the app last stopped is picked up where it was.
 * This is the whole point of the persistence layer: a lock screen, a reload, a
 * crash or a flat battery must not cost the race.
 */
async function recoverLiveRace(live) {
  if (!live) return;
  S.race = live;
  S.course = new Course(S.pack, live.course || {});
  S.engine = new RoundingEngine(S.course);
  S.engine.restore(live.engine);
  S.phase = live.phase || 'racing';
  S.gunAt = live.gunAt || null;
  S.targetAt = live.targetAt || null;
  try { S.track = markGaps(await loadTrack(live.id)); } catch { S.track = []; }
  if (S.track.length) {
    const last = S.track[S.track.length - 1];
    S.fix = { lat: last.lat, lon: last.lon, sog: last.sog, cog: last.cog, acc: last.acc };
  }
  try {
    S.recorder = await TrackRecorder.resume(live.id, live.startedAt, { onError: onStoreError });
  } catch { /* recording will restart on the next fix */ }

  const mins = S.track.length ? Math.round((Date.now() - (live.startedAt + S.track[S.track.length - 1].dt)) / 60000) : 0;
  toast(`Recovered "${live.name}" — ${S.track.length} fixes, ${S.engine.events.length} marks logged` +
    (mins > 1 ? `, ${mins} min gap since the last fix` : ''), 7000);
}

/** Flag the first fix after a recording gap so the chart draws a break. */
function markGaps(track) {
  for (let i = 1; i < track.length; i++) {
    if (track[i].dt - track[i - 1].dt > 30000 || (track[i].flags & FLAG_RESUME)) track[i].gap = true;
  }
  return track;
}

async function newRace(name) {
  const id = newId();
  S.race = {
    id,
    name: name || defaultRaceName(),
    packId: S.pack.id,
    club: S.pack.club,
    division: S.course.division,
    status: 'live',
    startedAt: Date.now(),
    finishedAt: null,
    phase: 'idle',
    gunAt: null,
    targetAt: null,
    course: S.course.toJSON(),
    engine: S.engine.state(),
    // A snapshot of where the marks were for THIS race. The pack can be
    // updated later without changing what was sailed today.
    markSnapshot: S.course.sequence().map(w => ({
      id: w.id, label: w.label, side: w.side,
      lat: w.pos ? w.pos.lat : null, lon: w.pos ? w.pos.lon : null,
    })),
    yacht: await getSetting('yacht', ''),
    sail: await getSetting('sail', ''),
  };
  S.track = [];
  S.engine = new RoundingEngine(S.course);
  S.phase = 'idle';
  S.gunAt = null;
  S.targetAt = null;
  S.recorder = new TrackRecorder(id, S.race.startedAt, { onError: onStoreError });
  await saveRace();
  renderAll();
}

function defaultRaceName() {
  const now = new Date();
  const iso = now.toISOString().slice(0, 10);
  const ev = (S.pack.events || []).find(e => e.from <= iso && iso <= e.to);
  const day = (S.pack.schedule || []).find(s => s.date === iso);
  return ev ? ev.name : day ? day.name : `Race ${iso}`;
}

async function saveRace(force) {
  if (!S.race) return;
  const now = Date.now();
  if (!force && now - S.lastSaveAt < 1500) return;
  S.lastSaveAt = now;
  S.race.course = S.course.toJSON();
  S.race.engine = S.engine.state();
  S.race.phase = S.phase;
  S.race.gunAt = S.gunAt;
  S.race.targetAt = S.targetAt;
  S.race.division = S.course.division;
  S.race.fixes = S.recorder ? S.recorder.count : S.track.length;
  try { await putRace(S.race); } catch (e) { onStoreError(e); }
}

function onStoreError(e) {
  warn('On-device storage failed — the track may not be saved. ' + (e && e.message ? e.message : ''));
}

async function finishRace() {
  if (!S.race) return;
  if (S.recorder) await S.recorder.flush(Date.now());
  S.race.status = 'finished';
  S.race.finishedAt = Date.now();
  S.race.elapsedSec = S.gunAt ? Math.round((S.race.finishedAt - S.gunAt) / 1000) : null;
  S.race.marksRounded = S.engine.events.filter(e => e.flag & FLAG_ROUNDED).length;
  S.phase = 'finished';
  await saveRace(true);
  stopGps();
  releaseWake();
  renderAll();
  toast('Race saved. Find it under Races to share or delete.', 6000);
}

// ---------------------------------------------------------------------------
// the start sequence — wall clock, not frame deltas
//
// SI 12.1: RRS 26, warning signal five minutes before the start. The countdown
// is the difference between now and an absolute target time, so a locked
// screen, a backgrounded tab or a throttled timer cannot make it drift: when
// the app comes back it simply reads the clock again.
// ---------------------------------------------------------------------------

function armStart(seconds) {
  S.targetAt = Date.now() + seconds * 1000;
  S.phase = 'pre';
  acquireWake();
  saveRace(true);
  renderAll();
}

function abortStart() {
  S.phase = 'idle';
  S.targetAt = null;
  saveRace(true);
  renderAll();
}

/** Set the gun to a wall-clock time today, e.g. the 11:00 start. */
function armAt(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = new Date();
  t.setHours(h, m, 0, 0);
  if (t.getTime() < Date.now()) t.setDate(t.getDate() + 1);
  S.targetAt = t.getTime();
  S.phase = 'pre';
  acquireWake();
  saveRace(true);
  renderAll();
}

function startRacing(at) {
  S.phase = 'racing';
  S.gunAt = at || Date.now();
  S.targetAt = null;
  if (S.fix) logEvent(FLAG_START);
  acquireWake();
  saveRace(true);
  renderAll();
}

function tickClock() {
  if (S.phase === 'pre' && S.targetAt != null) {
    const left = S.targetAt - Date.now();
    if (left <= 0) {
      startRacing(S.targetAt);
      toast('GUN — racing. Auto-advance armed.', 5000);
    }
  }
  renderClock();
  requestAnimationFrame(() => {});
}

// ---------------------------------------------------------------------------
// GPS
// ---------------------------------------------------------------------------

function startGps() {
  if (!('geolocation' in navigator)) { toast('This browser has no GPS.'); return; }
  if (S.gps.on) return;
  S.gps.on = true;
  S.gps.err = null;
  S.gps.watch = navigator.geolocation.watchPosition(onFix, onGpsError, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 30000,
  });
  acquireWake();
  renderAll();
}

function stopGps() {
  if (S.gps.watch != null) navigator.geolocation.clearWatch(S.gps.watch);
  S.gps.watch = null;
  S.gps.on = false;
  renderAll();
}

function onGpsError(err) {
  S.gps.err = err.code === 1
    ? 'Location permission denied — allow it in the browser settings.'
    : err.code === 3 ? 'Waiting for a fix…' : 'GPS unavailable.';
  if (err.code === 1) { S.gps.on = false; stopGps(); }
  renderStatus();
}

function onFix(p) {
  const c = p.coords;
  const now = p.timestamp || Date.now();
  const gap = S.gps.lastAt && (now - S.gps.lastAt > 30000);
  S.gps.lastAt = now;
  S.gps.err = null;

  const prev = S.fix;
  const fix = {
    lat: c.latitude, lon: c.longitude,
    acc: c.accuracy == null ? null : Math.round(c.accuracy),
    sog: 0, cog: prev ? prev.cog : 0, t: now,
  };
  if (c.speed != null && isFinite(c.speed) && c.speed >= 0) fix.sog = c.speed * 1.94384;
  else if (prev && prev.t) {
    const dt = (now - prev.t) / 1000;
    if (dt > 0.4) fix.sog = distNm(prev, fix) / dt * 3600;
  }
  // Heading from the GPS when it is moving; otherwise derive it from travel.
  // A stationary fix reports heading null (or a stale 0), so hold the last one.
  if (c.heading != null && isFinite(c.heading) && fix.sog > 0.5) fix.cog = c.heading;
  else if (prev && distNm(prev, fix) > 0.0008) fix.cog = brgTo(prev, fix);

  S.prevFix = prev;
  S.fix = fix;

  if (S.race && S.recorder) {
    const rec = {
      lat: fix.lat, lon: fix.lon,
      dt: Math.max(0, now - S.race.startedAt),
      sog: fix.sog, cog: fix.cog, acc: fix.acc,
      flags: gap ? FLAG_RESUME : 0,
    };
    S.recorder.add(rec, now);
    S.track.push({ ...rec, gap: !!gap });
    saveRace();
  }

  if (S.phase === 'racing' && S.engine) {
    const evs = S.engine.step(fix, prev, now);
    for (const ev of evs) {
      logEvent(ev.flag);
      announce(ev);
      if (ev.flag & FLAG_FINISH) finishRace();
    }
    if (evs.length) { saveRace(true); renderLegs(); }
  }

  draw();
  renderNumbers();
  renderStatus();
}

/** Stamp a flag onto the most recent recorded fix so events survive in the track. */
function logEvent(flag) {
  if (!S.track.length) return;
  S.track[S.track.length - 1].flags |= flag;
}

function announce(ev) {
  if (ev.flag & FLAG_FINISH) { toast('FINISH — ' + (ev.how === 'line' ? 'line crossed' : 'at the line'), 8000); return; }
  const side = ev.side === 'P' ? 'port' : ev.side === 'S' ? 'starboard' : '';
  toast(`Rounded ${ev.label}${side ? ' to ' + side : ''}` +
    (ev.how === 'quadrant' ? ' — valid quadrant fix ✓' : ' — proximity'), 7000);
  if (ev.how === 'quadrant' && S.pack.rules.declaration_si) showDeclaration(ev);
  if (navigator.vibrate) { try { navigator.vibrate([120, 60, 120]); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------------------
// screen wake lock
// ---------------------------------------------------------------------------

async function acquireWake() {
  S.wake.want = true;
  if (!('wakeLock' in navigator)) { renderStatus(); return; }
  if (S.wake.lock) return;
  try {
    S.wake.lock = await navigator.wakeLock.request('screen');
    S.wake.lock.addEventListener('release', () => { S.wake.lock = null; renderStatus(); });
  } catch { S.wake.lock = null; }
  renderStatus();
}

function releaseWake() {
  S.wake.want = false;
  if (S.wake.lock) { try { S.wake.lock.release(); } catch { /* ignore */ } }
  S.wake.lock = null;
  renderStatus();
}

// The lock is dropped whenever the page is hidden, so it has to be retaken
// every time the app comes back to the foreground.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (S.wake.want) acquireWake();
    renderClock();
    renderStatus();
    draw();
  } else if (S.recorder) {
    S.recorder.flush(Date.now());
    saveRace(true);
  }
});
window.addEventListener('pagehide', () => {
  if (S.recorder) S.recorder.flush(Date.now());
  saveRace(true);
});

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------

function draw() {
  if (!S.chart || !S.course) return;
  const seq = S.course.sequence();
  const pts = seq.map(w => w.pos).filter(Boolean);
  if (S.fix) pts.push(S.fix);
  const shown = decimate(S.track, 1200);
  for (const p of shown) pts.push(p);

  const box = el('chartwrap').getBoundingClientRect();
  const aspect = box.height > 40 && box.width > 40 ? box.height / box.width : 1;

  const ext = computeExtent(pts, {
    follow: S.follow, boat: S.fix,
    followSpanNm: +(el('zoom') ? el('zoom').value : 3),
  });

  const q = S.phase === 'racing' ? S.engine.currentQuadrant() : null;
  const wp = S.engine ? S.engine.current() : null;

  S.chart.draw({
    ext, aspect,
    seq, wpIdx: S.engine ? S.engine.wpIdx : 1,
    marks: S.course.allMarks(),
    zones: S.pack.zones,
    track: shown,
    boat: S.fix,
    nextPos: wp ? wp.pos : null,
    nextQuadrant: q,
    lineEnds: S.course.lineEnds,
    world: S.world,
    packCoast: S.packCoast,
    coastNote: S.packCoast && S.packCoast.attribution ? S.packCoast.attribution : 'Coast: Natural Earth',
  });
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function renderAll() {
  renderNumbers();
  renderLegs();
  renderStatus();
  renderClock();
  renderControls();
  renderBuilder();
  draw();
}

function renderNumbers() {
  const wp = S.engine ? S.engine.current() : null;
  el('nextmark').textContent = wp ? wp.label : S.phase === 'finished' ? 'FINISHED' : '—';
  const badge = el('sidebadge');
  if (wp && wp.side && wp.side !== 'G') {
    badge.textContent = wp.side === 'P' ? 'PORT' : 'STBD';
    badge.className = 'side ' + wp.side;
  } else if (wp && wp.role === 'finish') {
    badge.textContent = 'LINE'; badge.className = 'side N';
  } else if (wp && wp.side === 'G') {
    badge.textContent = 'GATE'; badge.className = 'side N';
  } else {
    badge.textContent = '—'; badge.className = 'side N';
  }

  const set = (id, v) => { el(id).textContent = v; };
  if (!S.fix || !wp || !wp.pos) {
    for (const id of ['brg', 'dtm', 'ttm', 'sog', 'cog', 'vmc']) set(id, '—');
    el('offline-note').hidden = !!S.fix;
    return;
  }
  el('offline-note').hidden = true;
  const d = distNm(S.fix, wp.pos);
  const b = brgTo(S.fix, wp.pos);
  const v = vmc(S.fix.sog, S.fix.cog, b);
  set('brg', fmtBrg(b));
  set('dtm', d < 10 ? d.toFixed(2) : d.toFixed(1));
  set('sog', (S.fix.sog || 0).toFixed(1));
  set('cog', fmtBrg(S.fix.cog || 0));
  set('vmc', v.toFixed(1));
  if (v > 0.3) {
    const mins = d / v * 60;
    const h = Math.floor(mins / 60), m = Math.floor(mins % 60);
    set('ttm', h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}:${String(Math.round((mins % 1) * 60)).padStart(2, '0')}`);
    el('ttm-unit').textContent = h > 0 ? 'h:mm' : 'm:ss';
  } else {
    set('ttm', '—');
    el('ttm-unit').textContent = '';
  }
  // off-course warning: VMC negative while racing means we are sailing away
  el('vmctile').classList.toggle('bad', v < -0.2);
}

function renderClock() {
  const c = el('clock');
  const strip = el('cdstrip');
  if (S.phase === 'pre' && S.targetAt != null) {
    const left = Math.max(0, S.targetAt - Date.now());
    const total = Math.ceil(left / 1000);
    const m = Math.floor(total / 60), s = total % 60;
    strip.hidden = false;
    el('cddig').textContent = `${m}:${String(s).padStart(2, '0')}`;
    el('cdstage').textContent = total > 240 ? 'WARNING'
      : total > 60 ? 'PREPARATORY' : total > 10 ? 'LAST MINUTE' : 'GUN';
    strip.classList.toggle('imminent', total <= 60);
    c.textContent = `T −${m}:${String(s).padStart(2, '0')}`;
  } else {
    strip.hidden = true;
    if (S.gunAt) {
      const el_ = Math.max(0, Date.now() - S.gunAt) / 1000;
      const h = Math.floor(el_ / 3600), m = Math.floor(el_ % 3600 / 60), s = Math.floor(el_ % 60);
      c.textContent = `T ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    } else {
      c.textContent = 'T --:--:--';
    }
  }
}

function renderStatus() {
  const gps = el('gpsstat');
  if (S.gps.err) { gps.textContent = S.gps.err; gps.className = 'stat warn'; }
  else if (!S.gps.on) { gps.textContent = 'GPS off'; gps.className = 'stat off'; }
  else if (!S.fix) { gps.textContent = 'acquiring…'; gps.className = 'stat warn'; }
  else {
    const age = Math.round((Date.now() - S.gps.lastAt) / 1000);
    gps.textContent = `GPS ±${S.fix.acc == null ? '?' : S.fix.acc} m` + (age > 5 ? ` · ${age}s old` : '');
    gps.className = 'stat ok';
  }

  const w = el('wakestat');
  if (!('wakeLock' in navigator)) { w.textContent = 'screen lock: not supported'; w.className = 'stat off'; }
  else if (S.wake.lock) { w.textContent = 'screen held awake'; w.className = 'stat ok'; }
  else if (S.wake.want) { w.textContent = 'screen lock: retrying'; w.className = 'stat warn'; }
  else { w.textContent = 'screen may sleep'; w.className = 'stat off'; }

  el('racename').textContent = S.race ? S.race.name : 'No race started';
  el('netstat').textContent = navigator.onLine ? 'online' : 'offline — GPS unaffected';
  el('netstat').className = 'stat ' + (navigator.onLine ? 'ok' : 'off');
}

function renderLegs() {
  const box = el('leglist');
  box.replaceChildren();
  if (!S.engine) return;
  const seq = S.course.sequence();
  const evById = new Map();
  for (const e of S.engine.events) evById.set(e.wpIdx, e);

  seq.forEach((wp, i) => {
    if (i === 0) return;
    const row = document.createElement('div');
    row.className = 'leg' + (i < S.engine.wpIdx ? ' done' : i === S.engine.wpIdx ? ' now' : '');
    const dot = document.createElement('span'); dot.className = 'dot';
    const nm = document.createElement('span'); nm.className = 'lnm';
    nm.textContent = `${i}. ${wp.label}`;
    if (wp.unplaced) nm.textContent += ' (position on the day)';
    row.append(dot, nm);

    if (wp.side && wp.side !== 'G') {
      const s = document.createElement('span');
      s.className = 'sd ' + wp.side;
      s.textContent = wp.side === 'P' ? 'PORT' : 'STBD';
      row.append(s);
    }
    const ev = evById.get(i);
    if (ev) {
      const tag = document.createElement('span');
      tag.className = 'how ' + ev.how;
      tag.textContent = ev.how === 'quadrant' ? 'quadrant ✓' : ev.how === 'manual' ? 'by hand' : ev.how;
      row.append(tag);
      if (ev.fix && S.pack.rules.declaration_si) {
        const btn = document.createElement('button');
        btn.className = 'mini';
        btn.textContent = 'declare';
        btn.onclick = () => showDeclaration(ev);
        row.append(btn);
      }
    }
    box.append(row);
  });

  const c = S.pack.courses.find(x => x.id === S.course.courseId);
  el('coursemeta').textContent =
    `${S.course.courseId}${c && !c.builder ? ' · ' + c.name : ''} · ${S.course.legs.length} marks · ~${S.course.lengthNm().toFixed(1)} nm`;
}

function renderControls() {
  el('btn-gps').textContent = S.gps.on ? '📍 GPS on' : '📍 Start GPS';
  el('btn-gps').classList.toggle('on', S.gps.on);
  const go = el('btn-go');
  if (S.phase === 'pre') { go.textContent = 'Abort start'; go.className = 'btn danger'; }
  else if (S.phase === 'racing') { go.textContent = 'Finish race'; go.className = 'btn'; }
  else { go.textContent = 'Arm start'; go.className = 'btn primary'; }
  el('btn-prev').disabled = !S.engine || S.engine.wpIdx <= 1;
  el('btn-next').disabled = !S.engine || S.engine.done();
  el('btn-ping').textContent = S.course && S.course.lineEnds.length
    ? `⚓ Line pinned (${S.course.lineEnds.length}/2)` : '⚓ Pin line end';
  el('follow').textContent = S.follow ? 'Follow boat' : 'Whole course';
  el('zoomwrap').hidden = !S.follow;
  el('btn-share').disabled = !S.course || !S.course.legs.length;
  applyCrewGating();
}

// ---------------------------------------------------------------------------
// course builder
// ---------------------------------------------------------------------------

/**
 * Load a published course onto the builder: its legs (resolving gates and
 * per-division sequences) and the lines it starts and finishes on.
 */
function loadPresetCourse(c, opts = {}) {
  const dv = c.div ? (c.div[S.course.division] || c.div.D2 || Object.values(c.div)[0]) : null;
  const seq = dv ? dv.seq : (c.seq || []);
  S.course.legs = seq.map(([mark, side]) =>
    side === 'G' ? { markId: mark.split('|')[0], side: 'P', gate: mark.split('|') } : { markId: mark, side });
  S.course.startId = c.start || null;
  S.course.finishId = c.finish || null;
  if (opts.quiet) return;
  if (S.pack.relative_marks && S.pack.relative_marks.length) {
    toast(`${c.id} loaded. Marks ${S.pack.relative_marks.map(m => m.id).join('/')} are laid on the day — check the board.`, 7000);
  } else {
    const fin = S.course.finishMark();
    toast(`Course ${c.id} loaded for ${S.course.division}` +
      (fin && !S.course.finishesAtStart() ? ` — finish is at ${fin.name}` : '') + '.', 7000);
  }
}

function renderBuilder() {
  // series
  const ksel = el('packsel');
  if (!ksel.options.length) {
    for (const p of PACKS) {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.name;
      ksel.append(o);
    }
  }
  ksel.value = S.pack.id;

  // division
  const dsel = el('division');
  if (!dsel.options.length) {
    for (const d of S.pack.divisions) {
      const o = document.createElement('option');
      o.value = d.id; o.textContent = d.name;
      dsel.append(o);
    }
  }
  dsel.value = S.course.division;
  const div = S.pack.divisions.find(d => d.id === S.course.division);
  el('divnote').textContent = div && div.note ? div.note : '';

  // preset courses
  const psel = el('preset');
  if (!psel.options.length) {
    for (const c of S.pack.courses) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.builder ? `${c.id} — build it here` : `${c.id} — ${c.name}`;
      psel.append(o);
    }
  }
  psel.value = S.course.courseId;

  // the built course
  const box = el('builtlegs');
  box.replaceChildren();
  if (!S.course.legs.length) {
    const d = document.createElement('div');
    d.className = 'hint';
    d.textContent = 'No marks yet. Tap marks above in the order you sail them.';
    box.append(d);
  }
  S.course.legs.forEach((leg, i) => {
    const m = S.course.markById(leg.markId);
    const row = document.createElement('div');
    row.className = 'blgrow';
    const n = document.createElement('span'); n.className = 'bn'; n.textContent = i + 1;
    const nm = document.createElement('span'); nm.className = 'bnm';
    nm.textContent = m ? `${m.id} — ${m.name}` : leg.markId;
    const side = document.createElement('button');
    side.className = 'sidetog ' + (leg.side || 'P');
    side.textContent = leg.side === 'S' ? 'STBD' : 'PORT';
    side.title = 'Tap to change the rounding side';
    side.onclick = () => { leg.side = leg.side === 'S' ? 'P' : 'S'; afterCourseEdit(); };
    const up = document.createElement('button'); up.className = 'mini'; up.textContent = '↑';
    up.disabled = i === 0;
    up.onclick = () => { const t = S.course.legs[i - 1]; S.course.legs[i - 1] = leg; S.course.legs[i] = t; afterCourseEdit(); };
    const rm = document.createElement('button'); rm.className = 'mini danger'; rm.textContent = '✕';
    rm.onclick = () => { S.course.legs.splice(i, 1); afterCourseEdit(); };
    row.append(n, nm, side, up, rm);
    box.append(row);
  });
  el('builtsummary').textContent = describeLegs(S.course, S.course.legs);

  // the mark palette, nearest first once we have a position
  const pal = el('palette');
  pal.replaceChildren();
  for (const entry of nearestMarks(S.course, S.fix || S.course.startPos())) {
    const b = document.createElement('button');
    b.className = 'markbtn' + (entry.mark.local ? ' local' : '') + (entry.pos ? '' : ' unplaced');
    const t = document.createElement('span'); t.className = 'mid'; t.textContent = entry.mark.id;
    const n = document.createElement('span'); n.className = 'mname'; n.textContent = entry.mark.name;
    b.append(t, n);
    if (entry.nm != null) {
      const d = document.createElement('span'); d.className = 'mdist';
      d.textContent = entry.nm < 10 ? entry.nm.toFixed(1) + ' nm' : Math.round(entry.nm) + ' nm';
      b.append(d);
    } else {
      const d = document.createElement('span'); d.className = 'mdist'; d.textContent = 'on the day';
      b.append(d);
    }
    b.onclick = () => {
      S.course.legs.push({ markId: entry.mark.id, side: S.pack.rules.default_rounding || 'P' });
      afterCourseEdit();
    };
    pal.append(b);
  }
}

function afterCourseEdit() {
  // Editing the course never touches the recorded track. If the race is
  // already running, the engine is clamped to a still-valid waypoint.
  const len = S.course.sequence().length;
  if (S.engine.wpIdx > len - 1) S.engine.wpIdx = Math.max(1, len - 1);
  saveRace(true);
  renderBuilder();
  renderLegs();
  renderNumbers();
  draw();
}

// ---------------------------------------------------------------------------
// panels
// ---------------------------------------------------------------------------

function showPanel(name) {
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.dataset.panel !== name;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t.dataset.tab === name);
  el('panelwrap').hidden = !name;
  if (name === 'races') renderRaces();
  if (name === 'settings') renderSettings();
  if (name === 'directory') renderDirectory();
  if (name === 'course') renderBuilder();
}

// ---------- races ----------

async function renderRaces() {
  const box = el('racelist');
  box.replaceChildren();
  let races;
  try { races = await listRaces(); } catch { box.textContent = 'Storage unavailable.'; return; }
  if (!races.length) { box.innerHTML = '<div class="hint">No saved races yet.</div>'; return; }
  for (const r of races) {
    const card = document.createElement('div');
    card.className = 'racecard' + (r.status === 'live' ? ' live' : '');
    const h = document.createElement('div'); h.className = 'rh';
    h.textContent = r.name + (r.status === 'live' ? '  ● recording' : '');
    const meta = document.createElement('div'); meta.className = 'rm';
    const when = new Date(r.startedAt);
    const bits = [when.toLocaleDateString(), when.toLocaleTimeString().slice(0, 5)];
    if (r.elapsedSec) {
      const h2 = Math.floor(r.elapsedSec / 3600), m2 = Math.floor(r.elapsedSec % 3600 / 60);
      bits.push(`elapsed ${h2}:${String(m2).padStart(2, '0')}`);
    }
    if (r.marksRounded != null) bits.push(`${r.marksRounded} marks`);
    if (r.fixes) bits.push(`${r.fixes} fixes · ${fmtBytes(r.fixes * FIX_BYTES)}`);
    meta.textContent = bits.join(' · ');
    const acts = document.createElement('div'); acts.className = 'racts';

    const mk = (label, fn, cls) => {
      const b = document.createElement('button');
      b.className = 'mini ' + (cls || '');
      b.textContent = label;
      b.onclick = fn;
      return b;
    };
    acts.append(
      mk('Share GPX', () => shareRace(r, 'gpx')),
      mk('Race card', () => shareRace(r, 'png')),
      mk('Delete', () => confirmDelete(r), 'danger'),
    );
    card.append(h, meta, acts);
    box.append(card);
  }
}

async function confirmDelete(r) {
  if (!confirm(`Delete "${r.name}" and its track? This cannot be undone.`)) return;
  await deleteRace(r.id);
  if (S.race && S.race.id === r.id) { S.race = null; S.recorder = null; S.track = []; renderAll(); }
  await refreshStorage();
  renderRaces();
  toast('Deleted.');
}

async function refreshStorage() {
  const info = await storageInfo();
  const parts = [];
  if (info.usage != null) parts.push(`using ${fmtBytes(info.usage)}`);
  if (info.quota != null) parts.push(`of ${fmtBytes(info.quota)} available`);
  parts.push(`${fmtBytes(info.bytesPerHour)}/hour at 1 Hz`);
  if (info.freeHours != null && isFinite(info.freeHours)) {
    parts.push(`room for ~${Math.round(info.freeHours).toLocaleString()} h of track`);
  }
  parts.push(info.persisted ? 'storage is persistent' : 'storage not marked persistent');
  const t = el('storagestat');
  if (t) t.textContent = parts.join(' · ');
}

// ---------- export and share ----------

function trackToGpx(race, fixes) {
  const name = (race.name || 'NextMark race').replace(/[<>&]/g, '');
  const segs = [];
  let cur = [];
  for (let i = 0; i < fixes.length; i++) {
    const f = fixes[i];
    if (i && (f.gap || f.flags & FLAG_RESUME)) { if (cur.length) segs.push(cur); cur = []; }
    cur.push(f);
  }
  if (cur.length) segs.push(cur);
  const body = segs.map(seg => '<trkseg>\n' + seg.map(f =>
    `<trkpt lat="${f.lat.toFixed(7)}" lon="${f.lon.toFixed(7)}">` +
    `<time>${new Date(race.startedAt + f.dt).toISOString()}</time>` +
    `<extensions><sog>${f.sog.toFixed(2)}</sog><cog>${f.cog.toFixed(1)}</cog></extensions>` +
    `</trkpt>`).join('\n') + '\n</trkseg>').join('\n');
  const wpts = (race.markSnapshot || []).filter(m => m.lat != null).map(m =>
    `<wpt lat="${m.lat.toFixed(7)}" lon="${m.lon.toFixed(7)}"><name>${m.id}</name>` +
    `<desc>${m.label}${m.side ? ' — leave to ' + (m.side === 'P' ? 'port' : 'starboard') : ''}</desc></wpt>`
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="NextMark" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${name}</name><time>${new Date(race.startedAt).toISOString()}</time></metadata>
${wpts}
<trk><name>${name}</name>
${body}
</trk>
</gpx>`;
}

async function raceCardPng(race, fixes) {
  const scale = 2;
  const W = 900, headH = 150;
  const chartH = 760;
  const cv = document.createElement('canvas');
  cv.width = W * scale; cv.height = (chartH + headH) * scale;
  const g = cv.getContext('2d');
  g.scale(scale, scale);
  g.fillStyle = COL.sea; g.fillRect(0, 0, W, chartH + headH);

  const pts = fixes.slice();
  for (const m of race.markSnapshot || []) if (m.lat != null) pts.push(m);
  if (!pts.length) return null;
  const ext = computeExtent(pts, {});
  const cos = Math.max(0.05, Math.abs(Math.cos((ext.lat0 + ext.lat1) / 2 * Math.PI / 180)));
  const wDeg = (ext.lon1 - ext.lon0), hDeg = (ext.lat1 - ext.lat0);
  const sx = W / wDeg, sy = chartH / hDeg;
  const s = Math.min(sx, sy * 1);
  const P = p => [
    (p.lon - ext.lon0) * s + (W - wDeg * s) / 2,
    headH + (ext.lat1 - p.lat) * (chartH / hDeg),
  ];

  // header
  g.fillStyle = COL.track; g.font = 'bold 40px "Arial Narrow", Arial, sans-serif';
  g.fillText('NEXTMARK', 26, 50);
  g.fillStyle = COL.ink; g.font = '30px "Arial Narrow", Arial, sans-serif';
  g.fillText(race.name, 26, 90);
  g.fillStyle = COL.dim; g.font = '20px Arial, sans-serif';
  const when = new Date(race.startedAt);
  const line2 = [
    when.toLocaleDateString(),
    race.yacht || '',
    race.elapsedSec != null
      ? `elapsed ${Math.floor(race.elapsedSec / 3600)}:${String(Math.floor(race.elapsedSec % 3600 / 60)).padStart(2, '0')}`
      : '',
    `${race.marksRounded || 0} marks rounded`,
    `${fixes.length} fixes`,
  ].filter(Boolean).join('  ·  ');
  g.fillText(line2, 26, 124);

  // course
  const seqPts = (race.markSnapshot || []).filter(m => m.lat != null);
  if (seqPts.length > 1) {
    g.strokeStyle = COL.course; g.lineWidth = 2.5; g.setLineDash([10, 8]);
    g.beginPath();
    seqPts.forEach((m, i) => { const [x, y] = P(m); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke();
    g.setLineDash([]);
  }
  // track, broken at gaps
  g.strokeStyle = COL.track; g.lineWidth = 3; g.lineJoin = 'round';
  g.beginPath();
  let started = false;
  for (const f of fixes) {
    const [x, y] = P(f);
    if (!started || f.gap) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
  }
  g.stroke();
  // marks
  g.font = 'bold 20px "Arial Narrow", Arial, sans-serif';
  for (const m of seqPts) {
    const [x, y] = P(m);
    g.fillStyle = m.side === 'P' ? COL.port : m.side === 'S' ? COL.stbd : COL.line;
    g.beginPath(); g.arc(x, y, 8, 0, Math.PI * 2); g.fill();
    g.fillStyle = COL.ink; g.fillText(m.id, x + 13, y + 7);
  }
  g.fillStyle = COL.dim; g.font = '16px Arial, sans-serif';
  g.fillText('Not for navigation', 26, chartH + headH - 18);

  return new Promise(res => cv.toBlob(res, 'image/png', 0.92));
}

async function shareRace(race, kind) {
  if (S.busy) return;
  S.busy = true;
  try {
    const fixes = markGaps(await loadTrack(race.id));
    if (!fixes.length) { toast('That race has no track recorded.'); return; }
    let file, name;
    if (kind === 'gpx') {
      name = slug(race.name) + '.gpx';
      file = new File([trackToGpx(race, fixes)], name, { type: 'application/gpx+xml' });
    } else {
      const blob = await raceCardPng(race, fixes);
      if (!blob) { toast('Could not render a card for that race.'); return; }
      name = slug(race.name) + '.png';
      file = new File([blob], name, { type: 'image/png' });
    }
    await deliver(file, race.name);
  } catch (e) {
    toast('Export failed: ' + (e && e.message ? e.message : 'unknown error'));
  } finally {
    S.busy = false;
  }
}

/**
 * Hand a file to the user. The share sheet is the right surface on a phone —
 * it reaches the crew group chat directly — and a download is the fallback on
 * a desktop browser.
 */
async function deliver(file, title) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, text: title });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;      // user dismissed the sheet
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
  toast('Saved to your downloads.');
}

function slug(s) {
  return 'nextmark-' + String(s || 'race').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// sharing a course to the crew
// ---------------------------------------------------------------------------

async function shareCourse() {
  if (!S.course.legs.length) {
    toast('Build the course first, then share it.');
    showPanel('course');
    return;
  }
  const name = (S.race && S.race.name) || defaultRaceName();
  const link = courseLink(S.course, { name, crew: true });
  const summary = describeLegs(S.course, S.course.legs);
  const text = `${name}\n${summary}\n\nTap to load it into NextMark:\n${link}`;

  // A long link gets mangled by some chat clients, so warn rather than let it
  // fail silently on someone else's phone.
  if (link.length > 1800) {
    toast('That course makes a very long link — some chat apps will cut it. Consider fewer added marks.', 9000);
  }

  if (navigator.share) {
    try { await navigator.share({ title: name, text }); return; } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Course link copied — paste it into the crew chat.', 7000);
  } catch {
    el('decltext').textContent = text;
    el('declnote').textContent = 'Copy this and paste it into the crew chat.';
    el('declnote').className = 'hint';
    el('decl').hidden = false;
  }
}

/** Read a ?#c=… course link, if the app was opened from one. */
async function handleIncomingLink() {
  const hash = location.hash || '';
  if (!/[#&?]c=/.test(hash)) return;
  const res = decodeCourse(hash);
  // Clear the fragment either way so a reload does not re-prompt.
  history.replaceState(null, '', location.pathname);

  if (!res.ok) { warn(res.error); return; }
  const prop = toSharedProposal(res.data, S.course);
  S.incoming = prop;
  renderIncoming(prop);
}

function renderIncoming(prop) {
  const box = el('incoming');
  box.replaceChildren();
  box.hidden = false;

  const h = document.createElement('div');
  h.className = 'phead';
  h.textContent = prop.problems.length && !prop.legs.length
    ? 'That shared course could not be loaded'
    : 'A course was shared with you';
  box.append(h);

  if (prop.name) {
    const n = document.createElement('div');
    n.className = 'rh';
    n.textContent = prop.name;
    box.append(n);
  }
  if (prop.legs.length) {
    const s = document.createElement('div');
    s.className = 'mono summary';
    s.textContent = describeLegs(S.course, prop.legs);
    box.append(s);
    const extra = [];
    if (prop.localMarks.length) extra.push(`${prop.localMarks.length} added mark(s)`);
    if (prop.lineEnds.length) extra.push(`a pinned start line`);
    if (prop.division) extra.push(prop.division === 'D1' ? 'Division 1' : prop.division === 'D2' ? 'Division 2' : prop.division);
    if (extra.length) box.append(hint('Includes ' + extra.join(', ') + '.'));
  }
  for (const p of prop.problems) {
    const d = document.createElement('div'); d.className = 'hint warn'; d.textContent = '⚠ ' + p;
    box.append(d);
  }

  const row = document.createElement('div');
  row.className = 'row end';
  const dismiss = document.createElement('button');
  dismiss.className = 'btn alt';
  dismiss.textContent = 'Not now';
  dismiss.onclick = () => { box.hidden = true; S.incoming = null; };
  row.append(dismiss);

  if (prop.legs.length) {
    const load = document.createElement('button');
    load.className = 'btn primary';
    load.textContent = 'Load this course';
    load.onclick = async () => {
      if (S.race && S.race.status === 'live' && S.phase === 'racing' &&
        !confirm('You are mid-race. Replace the course you are sailing?')) return;
      applySharedCourse(S.course, prop);
      if (prop.crew) await setCrew(true);
      if (!S.race) await newRace(prop.name || undefined);
      box.hidden = true;
      S.incoming = null;
      afterCourseEdit();
      renderAll();
      toast(`Loaded ${prop.legs.length} marks. Check them against the board before you start.`, 9000);
    };
    row.append(load);
  }
  box.append(row);
}

// ---------------------------------------------------------------------------
// crew mode
//
// On a boat only one person runs the start. Crew mode follows the helm's
// shared course and keeps its own track and its own numbers, but hides the
// controls that would diverge the two: the start sequence, course editing and
// the line pin.
// ---------------------------------------------------------------------------

async function setCrew(on) {
  S.crew = !!on;
  await setSetting('crew', S.crew);
  renderAll();
}

function applyCrewGating() {
  const crew = S.crew;
  el('crewbar').hidden = !crew;
  for (const id of ['btn-go', 'armlen', 'btn-armat', 'armat', 'btn-ping']) {
    const node = el(id);
    if (node) node.hidden = crew;
  }
  el('btn-crewstart').hidden = !crew || S.phase === 'racing';
  el('btn-crewstop').hidden = !crew || S.phase !== 'racing';

  // The shared course is read-only for crew, so eight phones cannot drift apart.
  // Headings and labels go with their controls — an orphaned "Division" label
  // over nothing just reads as a bug.
  for (const id of ['palette', 'palettehead', 'builtlegs', 'courserow', 'coursehelp']) {
    const node = el(id);
    if (node) node.hidden = crew;
  }
  el('crewcoursenote').hidden = !crew;
  el('newmarkblock').hidden = crew;
  el('boardblock').hidden = crew;
}

// ---------- SI 20.8 declaration ----------

function showDeclaration(ev) {
  const mark = S.course.markById(ev.id);
  const d = declaration(ev, {
    yacht: S.race ? S.race.yacht : '',
    sail: S.race ? S.race.sail : '',
    windowMin: S.pack.rules.declaration_window_min,
    markLat: mark ? mark.lat : null,
    markLon: mark ? mark.lon : null,
  });
  el('decltext').textContent = d.text;
  el('declnote').textContent = d.valid
    ? `SI 20.8: send this to the Race Officer within ${S.pack.rules.declaration_window_min} minutes — by ` +
      new Date(d.deadline).toTimeString().slice(0, 5) + '.'
    : 'This was not a quadrant fix, so it is not valid evidence of rounding under SI 10.7.';
  el('declnote').className = 'hint ' + (d.valid ? 'good' : 'warn');
  el('decl').hidden = false;
  el('decl').dataset.evIdx = String(S.engine.events.indexOf(ev));
}

async function shareDeclaration() {
  const text = el('decltext').textContent;
  const card = await declarationPng(text);
  if (card) {
    const file = new File([card], 'rounding-declaration.png', { type: 'image/png' });
    await deliver(file, 'Rounding declaration');
  } else if (navigator.share) {
    try { await navigator.share({ text }); } catch { /* dismissed */ }
  }
}

/**
 * SI 20.8 asks for "a photograph of an instrument displaying the fix and time
 * of the Rounding ... within the Rounding Quadrant". This renders exactly that
 * instrument view as an image, so it can be sent as an MMS.
 */
async function declarationPng(text) {
  const W = 700, H = 420;
  const cv = document.createElement('canvas');
  cv.width = W * 2; cv.height = H * 2;
  const g = cv.getContext('2d');
  g.scale(2, 2);
  g.fillStyle = '#07131C'; g.fillRect(0, 0, W, H);
  g.strokeStyle = '#22C3DA'; g.lineWidth = 2; g.strokeRect(10, 10, W - 20, H - 20);
  g.fillStyle = '#FF6A2B'; g.font = 'bold 28px "Arial Narrow", Arial, sans-serif';
  g.fillText('ROUNDING DECLARATION', 30, 54);
  g.fillStyle = '#6E8AA0'; g.font = '15px Arial, sans-serif';
  g.fillText('SI 20.8 · GPS fix within the published rounding quadrant (SI 10.7)', 30, 78);
  g.fillStyle = '#DCEAF2';
  const lines = text.split('\n');
  let y = 122;
  for (const l of lines) {
    g.font = (y === 122 ? 'bold 26px' : '22px') + ' ui-monospace, Consolas, monospace';
    g.fillText(l, 30, y);
    y += 36;
  }
  g.fillStyle = '#6E8AA0'; g.font = '14px Arial, sans-serif';
  g.fillText('Recorded by NextMark from the device GPS. Not for navigation.', 30, H - 26);
  return new Promise(res => cv.toBlob(res, 'image/png'));
}

// ---------- briefing photo ----------

async function onPhotoPicked(file) {
  if (!file) return;
  try {
    const prepared = await preparePhoto(file);
    S.photo = prepared;
    S.photo.dataUrl = await blobToDataUrl(prepared.blob);
    el('photoimg').src = S.photo.dataUrl;
    el('photowrap').hidden = false;
    el('photometa').textContent =
      `${prepared.width}×${prepared.height} · ${fmtBytes(prepared.bytes)} · kept on this device`;
    if (S.race) {
      S.race.boardPhoto = S.photo.dataUrl;
      await saveRace(true);
    }
    el('btn-read').hidden = !(await import('./ingest.js')).readerAvailable;
    renderReadButton();
    toast('Board saved to this device. Pinch to zoom it any time — no signal needed.');
  } catch (e) {
    toast('Could not read that photo: ' + (e.message || 'unknown error'));
  }
}

async function renderReadButton() {
  const s = await readerSettings();
  const btn = el('btn-read');
  btn.hidden = false;
  btn.disabled = !S.photo || (!s.apiKey && !s.proxyUrl);
  el('readnote').textContent = (s.apiKey || s.proxyUrl)
    ? 'Reads the board into a course you confirm before it goes on the chart.'
    : 'Add an API key in Settings to have the board read automatically — or just build the course by hand below.';
}

async function doReadBoard() {
  if (!S.photo || S.busy) return;
  S.busy = true;
  el('btn-read').disabled = true;
  el('readnote').textContent = 'Reading the board…';
  try {
    const res = await readBoard(S.photo.blob, S.pack);
    if (!res.ok) { el('readnote').textContent = res.error; return; }
    S.proposal = toProposal(res.data, S.course, S.course.division);
    renderProposal(res);
  } finally {
    S.busy = false;
    el('btn-read').disabled = false;
  }
}

function renderProposal(res) {
  const p = S.proposal;
  const box = el('proposal');
  box.replaceChildren();
  box.hidden = false;

  const h = document.createElement('div');
  h.className = 'phead';
  h.textContent = p.legible ? 'Read from the board — confirm before it goes on the chart' : 'Could not read the board';
  box.append(h);

  if (p.note) {
    const n = document.createElement('div'); n.className = 'hint'; n.textContent = p.note;
    box.append(n);
  }
  for (const prob of p.problems) {
    const d = document.createElement('div'); d.className = 'hint warn'; d.textContent = '⚠ ' + prob;
    box.append(d);
  }
  for (const d of p.divisions) {
    const row = document.createElement('div');
    row.className = 'prow' + (p.suggested === d ? ' suggested' : '');
    const t = document.createElement('div');
    t.className = 'pt';
    t.innerHTML = `<b>${escapeHtml(d.division)}</b><br><span class="mono">${escapeHtml(describeLegs(S.course, d.legs))}</span>`;
    const b = document.createElement('button');
    b.className = 'btn primary';
    b.textContent = 'Load this';
    b.onclick = () => {
      const r = applyProposal(S.course, p, d);
      if (!r.ok) { toast(r.error); return; }
      box.hidden = true;
      afterCourseEdit();
      toast(`Loaded ${r.count} marks for ${r.division}. Check it against the board.`, 8000);
    };
    row.append(t, b);
    box.append(row);
  }
  if (res && res.usage) {
    const u = document.createElement('div');
    u.className = 'hint';
    u.textContent = `${res.model} · ${res.usage.input_tokens} in / ${res.usage.output_tokens} out tokens`;
    box.append(u);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- add a mark by typed coordinates ----------

function addTypedMark() {
  const idRaw = el('nm-id').value.trim();
  const latRaw = el('nm-lat').value.trim();
  const lonRaw = el('nm-lon').value.trim();
  const note = el('nm-note');

  // One field accepts a whole pasted position, which is how it arrives over VHF.
  let pos = null;
  if (latRaw && !lonRaw) pos = parsePair(latRaw);
  if (!pos && latRaw && lonRaw) {
    const la = parseOne(latRaw, 'lat'), lo = parseOne(lonRaw, 'lon');
    if (la != null && lo != null) pos = { lat: la, lon: lo };
  }
  if (!pos) {
    note.textContent = 'Could not read that position. Try "28 11.200 S" and "153 34.300 E", or paste both together.';
    note.className = 'hint warn';
    return;
  }
  const m = S.course.addLocalMark({ id: idRaw || 'NEW', name: el('nm-name').value.trim() || undefined, ...pos });
  note.textContent = `Added ${m.id} at ${fmtDDM(m.lat, m.lon)}` +
    (S.fix ? ` — ${distNm(S.fix, m).toFixed(2)} nm away, bearing ${fmtBrg(brgTo(S.fix, m))}` : '');
  note.className = 'hint good';
  el('nm-id').value = ''; el('nm-name').value = ''; el('nm-lat').value = ''; el('nm-lon').value = '';
  afterCourseEdit();
}

function useMyPosition() {
  if (!S.fix) { el('nm-note').textContent = 'No GPS fix yet.'; el('nm-note').className = 'hint warn'; return; }
  el('nm-lat').value = fmtDDM(S.fix.lat, null);
  el('nm-lon').value = fmtDDM(null, S.fix.lon) === '—' ? '' : fmtDDM(S.fix.lat, S.fix.lon).split(' ')[1];
  el('nm-note').textContent = 'Filled from the current fix.';
  el('nm-note').className = 'hint';
}

// ---------- settings ----------

async function renderSettings() {
  const s = await readerSettings();
  el('set-crew').checked = S.crew;
  el('set-yacht').value = await getSetting('yacht', '');
  el('set-sail').value = await getSetting('sail', '');
  el('set-key').value = s.apiKey ? '••••••••' + s.apiKey.slice(-4) : '';
  el('set-proxy').value = s.proxyUrl;
  el('set-model').value = s.model;
  el('set-wind').value = S.course.windFrom == null ? '' : String(S.course.windFrom);
  await refreshStorage();
  el('persistnote').textContent = (await storageInfo()).persisted
    ? 'This origin is marked persistent — the browser will not evict your races.'
    : 'Not marked persistent. Add the app to your Home Screen so the browser keeps your races.';
}

async function saveSettings() {
  await setSetting('yacht', el('set-yacht').value.trim());
  await setSetting('sail', el('set-sail').value.trim());
  const k = el('set-key').value.trim();
  if (k && !k.startsWith('••')) await saveReaderSettings({ apiKey: k });
  await saveReaderSettings({ proxyUrl: el('set-proxy').value, model: el('set-model').value });
  if (S.race) {
    S.race.yacht = el('set-yacht').value.trim();
    S.race.sail = el('set-sail').value.trim();
    await saveRace(true);
  }
  const w = el('set-wind').value.trim();
  // Wind only re-lays the laid clearance mark. It never resets anything.
  S.course.windFrom = w === '' ? null : ((+w % 360) + 360) % 360;
  await saveRace(true);
  renderReadButton();
  afterCourseEdit();
  toast('Saved.');
}

// ---------- directory ----------

function renderDirectory() {
  const box = el('dirlist');
  box.replaceChildren();
  const today = new Date().toISOString().slice(0, 10);

  const head = document.createElement('div');
  head.className = 'dirhead';
  head.innerHTML = `<b>${escapeHtml(S.pack.club)}</b> · ${escapeHtml(S.pack.state)}, ${escapeHtml(S.pack.country)}` +
    `<br><span class="hint">${escapeHtml(S.pack.source.title)}</span>`;
  const link = document.createElement('a');
  link.href = S.pack.source.url; link.target = '_blank'; link.rel = 'noopener';
  link.className = 'mini'; link.textContent = 'Open the SIs';
  head.append(document.createElement('br'), link);
  box.append(head);

  const upcoming = [
    ...(S.pack.schedule || []).filter(s => s.date >= today).map(s => ({ date: s.date, name: s.name, kind: s.type })),
    ...(S.pack.events || []).filter(e => e.to >= today).map(e => ({ date: e.from, name: e.name, kind: 'EVENT' })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  const h2 = document.createElement('div'); h2.className = 'phead'; h2.textContent = 'Next races';
  box.append(h2);
  if (!upcoming.length) box.append(hint('Nothing left on this season\'s schedule.'));
  for (const r of upcoming.slice(0, 12)) {
    const row = document.createElement('div');
    row.className = 'dirrow';
    const d = new Date(r.date + 'T00:00:00');
    const days = Math.round((d - new Date(today + 'T00:00:00')) / 86400000);
    row.innerHTML =
      `<span class="dd">${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</span>` +
      `<span class="dn">${escapeHtml(r.name)}</span>` +
      `<span class="dk">${escapeHtml(r.kind)}</span>` +
      `<span class="dt">${days === 0 ? 'today' : days === 1 ? 'tomorrow' : days + ' days'}</span>`;
    const b = document.createElement('button');
    b.className = 'mini';
    b.textContent = 'Start race';
    b.onclick = async () => { await newRace(r.name); showPanel('course'); toast(`Started "${r.name}". Build the course from the briefing board.`, 7000); };
    row.append(b);
    box.append(row);
  }

  const h3 = document.createElement('div'); h3.className = 'phead'; h3.textContent = 'Other packs';
  box.append(h3, hint(
    'Only the Southport Yacht Club Offshore Division pack is extracted so far. ' +
    'Each pack is a club\'s permanent marks and courses, so one download covers the whole season.'));
}

function hint(t) {
  const d = document.createElement('div'); d.className = 'hint'; d.textContent = t; return d;
}

// ---------------------------------------------------------------------------
// static UI and events
// ---------------------------------------------------------------------------

function buildStaticUi() {
  const rules = S.pack.rules;
  el('packname').textContent = S.pack.name;
  el('vhf').textContent = `VHF ${rules.vhf_race}` +
    (rules.vhf_seaway ? ` race · ${rules.vhf_seaway} seaway` : '');

  if (S.pack.course_note) el('coursehelp').textContent = S.pack.course_note;
  el('legsheadk').textContent = rules.quadrant_si
    ? 'Course — auto-advances on a valid quadrant fix'
    : 'Course — auto-advances within ~75 m of each mark';

  const sel = el('armlen');
  const presets = rules.arm_presets ||
    [['5:00 (SI 12.1)', 300], ['3:00', 180], ['1:00', 60], ['0:20 test', 20]];
  for (const [label, sec] of presets) {
    const o = document.createElement('option'); o.value = String(sec); o.textContent = label; sel.append(o);
  }
  // Pursuit starts land on any minute of the clock, so this is a time field,
  // prefilled with the series' earliest start.
  el('armat').value = rules.first_start_hint || '11:00';
}

function wireEvents() {
  el('btn-gps').onclick = () => (S.gps.on ? stopGps() : startGps());

  el('btn-go').onclick = async () => {
    if (S.phase === 'pre') { abortStart(); return; }
    if (S.phase === 'racing') { if (confirm('Finish and save this race?')) await finishRace(); return; }
    if (!S.race) await newRace();
    if (!S.course.legs.length && !confirm('No marks in the course yet. Arm the start anyway?')) {
      showPanel('course'); return;
    }
    armStart(+el('armlen').value);
  };
  el('btn-armat').onclick = async () => {
    const t = el('armat').value;
    if (!t) { toast('Set your start time first — for a pursuit race it is your allocated handicap time.'); return; }
    if (!S.race) await newRace();
    armAt(t);
  };
  el('btn-gun').onclick = () => { if (confirm('Record the gun now?')) startRacing(Date.now()); };

  el('btn-next').onclick = () => {
    const wp = S.engine.current();
    if (!wp) return;
    const why = prompt(
      `Advance past ${wp.label} by hand?\n\n` +
      'This is for a mark that is off station, a missed fix, or a mark the RC has moved. ' +
      'The track keeps recording either way.\n\nReason (optional):', '');
    if (why === null) return;
    const ev = S.engine.advance(1, S.fix, Date.now(), why || null);
    if (ev) { logEvent(FLAG_MANUAL); saveRace(true); }
    if (S.engine.done()) finishRace();
    renderLegs(); renderNumbers(); renderControls(); draw();
  };
  el('btn-prev').onclick = () => {
    S.engine.advance(-1, S.fix, Date.now());
    saveRace(true);
    renderLegs(); renderNumbers(); renderControls(); draw();
  };

  el('btn-ping').onclick = () => {
    if (!S.fix) { toast('No GPS fix yet.'); return; }
    if (S.course.lineEnds.length >= 2) {
      S.course.lineEnds = [];
      toast('Line cleared — back to the published position.');
    } else {
      S.course.lineEnds.push({ lat: S.fix.lat, lon: S.fix.lon });
      toast(S.course.lineEnds.length === 1
        ? 'One end pinned. Motor to the other end and pin it to get a real line.'
        : 'Line pinned. Crossing it now counts as a finish.');
    }
    afterCourseEdit();
    renderControls();
  };

  el('follow').onclick = () => { S.follow = !S.follow; renderControls(); draw(); };
  el('zoom').oninput = () => draw();

  el('packsel').onchange = async e => {
    const id = e.target.value;
    if (id === S.pack.id) return;
    // A recording race belongs to its pack; switching under it would re-score
    // the day's roundings against the wrong marks.
    if (S.race && S.race.status === 'live') {
      toast('Finish or save the recording race before switching series.', 7000);
      e.target.value = S.pack.id;
      return;
    }
    await setSetting('pack', id);
    location.reload();
  };
  el('division').onchange = async e => {
    S.course.division = e.target.value;
    await setSetting('division', e.target.value);
    // A per-division course (twilight) changes its marks with the division.
    const c = S.pack.courses.find(x => x.id === S.course.courseId);
    if (c && c.div) loadPresetCourse(c, { quiet: true });
    renderBuilder(); afterCourseEdit();
  };
  el('preset').onchange = e => {
    const c = S.pack.courses.find(x => x.id === e.target.value);
    S.course.courseId = e.target.value;
    if (c && !c.builder) loadPresetCourse(c);
    else { S.course.startId = (c && c.start) || null; S.course.finishId = (c && c.finish) || null; }
    afterCourseEdit();
  };
  el('btn-clearcourse').onclick = () => {
    if (!S.course.legs.length || confirm('Clear every mark from the course? The recorded track is not affected.')) {
      S.course.legs = [];
      afterCourseEdit();
    }
  };

  el('photo').onchange = e => onPhotoPicked(e.target.files && e.target.files[0]);
  el('btn-read').onclick = doReadBoard;

  el('btn-addmark').onclick = addTypedMark;
  el('btn-herepos').onclick = useMyPosition;

  el('btn-savesettings').onclick = saveSettings;
  el('btn-persist').onclick = async () => {
    const got = await requestPersistence();
    toast(got
      ? 'Storage marked persistent — your races will not be evicted.'
      : 'The browser would not grant it. Add the app to your Home Screen instead.');
    renderSettings();
  };

  el('btn-newrace').onclick = async () => {
    if (S.race && S.race.status === 'live' &&
      !confirm('Start a new race? The current one stays saved under Races.')) return;
    if (S.race && S.race.status === 'live') await finishRace();
    const name = prompt('Name this race:', defaultRaceName());
    if (name === null) return;
    await newRace(name.trim() || defaultRaceName());
    toast('New race started.');
  };

  el('btn-share').onclick = shareCourse;

  // Crew mode: no start sequence — one tap begins recording and arms the
  // auto-advance. The helm times the start; the crew just need the numbers.
  el('btn-crewstart').onclick = async () => {
    if (!S.race) await newRace();
    startRacing(Date.now());
    if (!S.gps.on) startGps();
    toast('Recording. Your track and roundings are yours alone.', 6000);
  };
  el('btn-crewstop').onclick = async () => {
    if (confirm('Stop recording and save this race?')) await finishRace();
  };
  el('set-crew').onchange = e => setCrew(e.target.checked);

  el('decl-share').onclick = shareDeclaration;
  el('decl-close').onclick = () => { el('decl').hidden = true; };

  for (const t of document.querySelectorAll('.tab')) {
    t.onclick = () => showPanel(t.classList.contains('on') ? '' : t.dataset.tab);
  }
  el('warnbar').onclick = () => { el('warnbar').hidden = true; };

  // Tapping a share link while the app is already open only changes the
  // fragment — the browser does not reload, so boot() never re-runs. Without
  // this, a crew member with the app open taps the helm's link and nothing
  // happens at all.
  window.addEventListener('hashchange', () => { handleIncomingLink(); });

  window.addEventListener('online', renderStatus);
  window.addEventListener('offline', renderStatus);
  window.addEventListener('resize', () => draw());

  setInterval(tickClock, 250);
  setInterval(() => { renderStatus(); }, 2000);
  setInterval(() => { if (S.race) saveRace(); }, 5000);
}

// A silent startup failure on a boat is the worst outcome — you find out at the
// first mark. Surface it on screen instead.
boot().catch(e => {
  console.error('[nextmark] startup failed', e);
  fatal('NextMark failed to start: ' + (e && e.message ? e.message : e) +
    ' — reload, and if it persists reinstall from the link.');
});
