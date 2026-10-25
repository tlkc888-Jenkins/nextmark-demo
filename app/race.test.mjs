// node app/race.test.mjs
//
// Sails a simulated Cook Island Race through the real SYC Offshore pack and
// checks the parts that decide whether the app is trustworthy on the water:
// SI 10.7 quadrant rounding, the manual override, the briefing-board ingest,
// and the SI 20.8 declaration.

import fs from 'node:fs';
import { Course, RoundingEngine, declaration, QUAD_NM, PROX_NM, offStation } from './race.js';
import { toProposal, applyProposal, describeLegs, boardSchema } from './ingest.js';
import { distNm, brgTo, movePt, fmtDDM } from './geo.js';
import { FLAG_MANUAL, FLAG_ROUNDED, FLAG_FINISH, encodeFix, decodeFix, FIX_BYTES } from './store.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL ' + name + (extra ? '  — ' + extra : '')); }
};
const group = n => console.log('\n' + n);

const pack = JSON.parse(fs.readFileSync(new URL('../data/syc-offshore-2627.json', import.meta.url)));

group('pack integrity');
ok('pack id', pack.id === 'syc-offshore-2627');
ok('13 marks', pack.marks.length === 13, String(pack.marks.length));
ok('Cook Island Mark present', !!pack.marks.find(m => m.id === 'D'));
const D = pack.marks.find(m => m.id === 'D');
ok('Cook Island position', Math.abs(D.lat + 28.186667) < 1e-5 && Math.abs(D.lon - 153.571667) < 1e-5,
  `${D.lat} ${D.lon}`);
ok('Cook Island quadrant is SW', D.quadrants[0].b1 === 180 && D.quadrants[0].b2 === 270);
ok('two marks have no position', pack.marks.filter(m => m.lat == null).length === 2);
ok('default rounding is port', pack.rules.default_rounding === 'P');
ok('off-station limit is 200 m', pack.rules.off_station_m === 200);
ok('warning signal is 5 min', pack.rules.warning_signal_sec === 300);
ok('declaration window is 15 min', pack.rules.declaration_window_min === 15);
ok('X1 is a builder course', pack.courses.find(c => c.id === 'X1').builder === true);
ok('6 W/L courses defined', pack.courses.filter(c => c.type === 'W/L').length === 6);
ok('Wonder Reef zone present', !!pack.zones.find(z => z.id === 'wonder-reef'));
ok('4 wave buoy exclusions', pack.zones.filter(z => z.type === 'exclusion').length === 4);
ok('Cook Island Race in events', !!pack.events.find(e => e.name === 'Cook Island Yacht Race'));
ok('next passage race 15 Nov', !!pack.schedule.find(s => s.date === '2026-11-15'));

group('structured-output schema is API-legal');
const schema = boardSchema(['A', 'B', 'D']);
(function checkSchema(node, path) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'object') {
    ok(`${path} forbids extra properties`, node.additionalProperties === false);
    const props = Object.keys(node.properties || {});
    const req = node.required || [];
    ok(`${path} requires every property`, props.length === req.length && props.every(p => req.includes(p)),
      `props ${props.length} vs required ${req.length}`);
  }
  // unsupported-by-the-API keywords must not appear
  for (const bad of ['minimum', 'maximum', 'minLength', 'maxLength', 'multipleOf', 'pattern']) {
    ok(`${path} has no ${bad}`, !(bad in node));
  }
  for (const k of Object.keys(node.properties || {})) checkSchema(node.properties[k], path + '.' + k);
  if (node.items) checkSchema(node.items, path + '[]');
})(schema, 'root');

group('building the Cook Island course by hand');
// The RC sets course X1 at the briefing. A plausible Cook Island Race: south
// past Surfers and Currumbin to the Cook Island Mark, then back. Leaving each
// mark to port southbound and to starboard northbound keeps the boat inshore
// of them, which is what the published quadrants describe.
const course = new Course(pack, { courseId: 'X1', division: 'D2' });
course.legs = [
  { markId: 'A', side: 'P' },
  { markId: 'C', side: 'P' },
  { markId: 'D', side: 'P' },
  { markId: 'C', side: 'S' },
  { markId: 'A', side: 'S' },
];
const seq = course.sequence();
ok('sequence is start + 5 marks + finish', seq.length === 7, String(seq.length));
ok('starts at the line', seq[0].role === 'start');
ok('ends at the line', seq[6].role === 'finish');
ok('start and finish share a position',
  seq[0].pos.lat === seq[6].pos.lat && seq[0].pos.lon === seq[6].pos.lon);
ok('course length is plausible', course.lengthNm() > 30 && course.lengthNm() < 42,
  course.lengthNm().toFixed(1) + ' nm');
ok('every waypoint is placed', seq.every(w => w.pos), 'an unplaced mark slipped through');

group('quadrant selection follows the leg direction');
const eng = new RoundingEngine(course);
ok('leg to A is southerly', course.legBearing(seq, 1) > 150 && course.legBearing(seq, 1) < 210,
  course.legBearing(seq, 1).toFixed(0));
ok('leg home to A is northerly', course.legBearing(seq, 5) > 300 || course.legBearing(seq, 5) < 60,
  course.legBearing(seq, 5).toFixed(0));
const q1 = eng.currentQuadrant();
ok('first quadrant is the SW one', q1 && q1.quad.dir === 'S' && q1.quad.b1 === 180);

group('sailing it — auto rounding only fires inside the quadrant');
/** Walk the boat along the course, feeding fixes at 1 Hz-ish spacing. */
function sail(engine, crs, opts = {}) {
  const log = [];
  let prev = null;
  let boat = { ...crs.startPos() };
  let guard = 0;
  const berth = opts.berthNm == null ? 0.02 : opts.berthNm;   // how wide we round
  while (!engine.done() && guard++ < 4000) {
    const wp = engine.current();
    if (!wp || !wp.pos) break;
    // aim just inside the correct side of the mark so the fix lands in the quadrant
    const legBrg = brgTo(boat, wp.pos);
    const quad = wp.quadrants
      ? (wp.quadrants.find(q => q.dir === '*')
        || wp.quadrants.find(q => q.dir === (legBrg > 90 && legBrg < 270 ? 'S' : 'N')))
      : null;
    let aim = wp.pos;
    if (quad && berth > 0) {
      const mid = ((quad.b1 === 0 ? 360 : quad.b1) + quad.b2) / 2;
      aim = movePt(wp.pos, mid, berth);
    }
    // step toward the aim point
    const d = distNm(boat, aim);
    const step = Math.min(0.02, Math.max(0.004, d));
    boat = movePt(boat, brgTo(boat, aim), step);
    boat.sog = 7.5; boat.cog = brgTo(prev || boat, boat); boat.acc = 6;
    const evs = engine.step(boat, prev, 1_760_000_000_000 + guard * 1000);
    for (const e of evs) log.push(e);
    prev = { ...boat };
    if (d < step * 1.1 && !evs.length) {
      // arrived at the aim point without registering — give up on this mark
      if (opts.allowStall) break;
      ok('sail did not stall at ' + wp.label, false);
      break;
    }
  }
  return log;
}

const log = sail(eng, course);
const rounds = log.filter(e => e.flag === FLAG_ROUNDED);
const finishes = log.filter(e => e.flag === FLAG_FINISH);
ok('five marks rounded then the line taken', log.length === 6, `${log.length}: ` + log.map(e => e.id).join(','));
ok('all five marks by quadrant', rounds.length === 5 && rounds.every(e => e.how === 'quadrant'),
  log.map(e => e.how).join(','));
ok('rounded in course order', rounds.map(e => e.id).join(',') === 'A,C,D,C,A', rounds.map(e => e.id).join(','));
ok('finish recorded', finishes.length === 1 && finishes[0].id === 'SF');
// With only a published position for the line, the finish is a proximity hit,
// not a crossing — and must say so rather than claiming a line.
ok('finish labelled proximity, not line', finishes[0].how === 'proximity', finishes[0].how);
ok('course is complete', eng.done() && eng.finishedAt != null);
ok('A rounded to port then starboard',
  rounds[0].side === 'P' && rounds[4].side === 'S');

group('a wide berth does not auto-round — and the override recovers it');
const wide = new Course(pack, { courseId: 'X1', division: 'D2' });
wide.legs = [{ markId: 'D', side: 'P' }];
const engWide = new RoundingEngine(wide);
// Pass 0.5 nm off the mark: correct side, but far outside the quadrant radius.
let prev = null, boat = { ...wide.startPos() };
const far = movePt(wide.posOf('D'), 225, 0.5);
for (let i = 0; i < 400; i++) {
  boat = movePt(boat, brgTo(boat, far), 0.05);
  boat.sog = 7; boat.cog = 180; boat.acc = 5;
  engWide.step(boat, prev, Date.parse('2026-11-01T01:00:00Z') + i * 1000);
  prev = { ...boat };
  if (distNm(boat, far) < 0.05) break;
}
ok('wide pass did not auto-round', engWide.wpIdx === 1 && engWide.events.length === 0);
const manual = engWide.advance(1, boat, Date.parse('2026-11-01T01:10:00Z'), 'mark was off station');
ok('manual advance recorded', manual && manual.how === 'manual');
ok('manual advance flagged', manual.flag === FLAG_MANUAL);
ok('manual advance carries the reason', manual.reason === 'mark was off station');
ok('course moved on', engWide.wpIdx === 2);
ok('now on the finish', engWide.current().role === 'finish');
engWide.advance(-1, boat, 0);
ok('step back undoes it', engWide.wpIdx === 1 && engWide.events.length === 0);

group('SI 10.3 off-station check');
const obs = movePt(wide.posOf('D'), 90, 0.15);        // 278 m east of station
const off = offStation(wide, 'D', obs);
ok('off-station limit read from the pack', off.limit === 200);
ok('278 m is off station', off.offStation === true, off.metres.toFixed(0) + ' m');
const near = offStation(wide, 'D', movePt(wide.posOf('D'), 90, 0.05));
ok('93 m is on station', near.offStation === false, near.metres.toFixed(0) + ' m');

group('SI 20.8 declaration');
const ev = log[2];                                     // the Cook Island rounding
const decl = declaration(ev, {
  yacht: 'Kraken', sail: 'AUS 52', windowMin: pack.rules.declaration_window_min,
  markLat: D.lat, markLon: D.lon,
});
ok('declaration names the yacht', decl.text.includes('Kraken (AUS 52)'));
ok('declaration names the mark', decl.text.includes('Cook Island'));
ok('declaration carries the fix', /\d+°\d+\.\d+′S \d+°\d+\.\d+′E/.test(decl.text), decl.text);
ok('declaration carries the quadrant', /Quadrant 180–270/.test(decl.text), decl.text);
ok('declaration states the fix bearing', /fix bore \d{3}/.test(decl.text), decl.text);
ok('declaration is valid for a quadrant fix', decl.valid === true);
ok('deadline is 15 minutes out', decl.deadline - ev.at === 15 * 60000);
const manualDecl = declaration(
  { ...ev, how: 'manual', quad: null }, { yacht: 'Kraken', windowMin: 15 });
ok('a manual advance is not a valid declaration', manualDecl.valid === false);
ok('and says so', manualDecl.text.includes('Advanced manually'));

group('typed-in mark from a VHF call');
const vhf = new Course(pack, { courseId: 'X1', division: 'D2' });
const added = vhf.addLocalMark({ id: 'M5', name: 'New Mark 5', lat: -28.05, lon: 153.52 });
ok('mark added', added.id === 'M5');
ok('marked as not from the SIs', vhf.markById('M5').local === true);
vhf.legs = [{ markId: 'M5', side: 'P' }];
ok('typed mark resolves in the sequence', vhf.sequence()[1].pos.lat === -28.05);
ok('typed mark has no quadrant, so proximity applies', !vhf.sequence()[1].quadrants);
const engVhf = new RoundingEngine(vhf);
const nearNew = movePt(vhf.posOf('M5'), 10, PROX_NM * 0.5);
const evs = engVhf.step(nearNew, null, 1);
ok('proximity rounds the typed mark', evs.length === 1 && evs[0].how === 'proximity');
// id collision
const dup = vhf.addLocalMark({ id: 'M5', name: 'Another', lat: -28.06, lon: 153.53 });
ok('duplicate id is made unique', dup.id === 'M52', dup.id);
vhf.removeLocalMark('M5');
ok('removing a mark drops its leg', vhf.legs.length === 0);

group('briefing board ingest — a realistic Cook Island board');
const boardData = {
  legible: true,
  note: 'Whiteboard listing two divisions for the Cook Island Race.',
  course_label: 'X1',
  divisions: [
    { division: 'Division 1', legs: [
      { mark: 'A', side: 'P' }, { mark: 'D', side: 'P' }, { mark: 'A', side: 'S' }] },
    { division: 'Division 2', legs: [
      { mark: 'A', side: 'P' }, { mark: 'C', side: 'P' }, { mark: 'A', side: 'S' }] },
  ],
  new_marks: [],
  unmatched: [],
};
const prop = toProposal(boardData, course, 'D2');
ok('proposal is legible', prop.legible === true);
ok('two divisions read', prop.divisions.length === 2);
ok('no problems', prop.problems.length === 0, prop.problems.join('; '));
ok('Division 2 auto-selected', prop.suggested && prop.suggested.division === 'Division 2',
  prop.suggested && prop.suggested.division);
const target = new Course(pack, { courseId: 'X1', division: 'D2' });
const applied = applyProposal(target, prop);
ok('applied', applied.ok === true);
ok('three legs applied', target.legs.length === 3, String(target.legs.length));
ok('legs are A/C/A', target.legs.map(l => l.markId).join(',') === 'A,C,A');
ok('sides preserved', target.legs.map(l => l.side).join(',') === 'P,P,S');
ok('describeLegs reads correctly',
  describeLegs(target, target.legs) === 'Start — A(P) — C(P) — A(S) — Finish',
  describeLegs(target, target.legs));
const sailedBoard = sail(new RoundingEngine(target), target);
ok('the applied course can actually be sailed — 3 marks plus the finish',
  sailedBoard.length === 4 && sailedBoard.filter(e => e.how === 'quadrant').length === 3,
  sailedBoard.map(e => `${e.id}:${e.how}`).join(','));

group('board ingest — a new mark given by coordinates');
const boardNew = {
  legible: true, note: 'Board adds a laid mark.', course_label: 'X1',
  divisions: [{ division: 'Division 2', legs: [{ mark: 'A', side: 'P' }, { mark: 'LAID', side: 'S' }] }],
  new_marks: [{ label: 'LAID', coords: '28 03.500 S 153 29.000 E', side: 'S' }],
  unmatched: [],
};
const propNew = toProposal(boardNew, course, 'D2');
ok('new mark parsed', propNew.newMarks.length === 1);
ok('new mark position correct',
  Math.abs(propNew.newMarks[0].pos.lat + 28.058333) < 1e-5, String(propNew.newMarks[0].pos.lat));
ok('no problems for the new mark', propNew.problems.length === 0, propNew.problems.join('; '));
const t2 = new Course(pack, { courseId: 'X1', division: 'D2' });
applyProposal(t2, propNew);
ok('new mark landed on the course', !!t2.markById('LAID'));
ok('new mark flagged as local', t2.markById('LAID').local === true);
ok('both legs applied', t2.legs.length === 2);
ok('new-mark leg resolves to a position', t2.sequence()[2].pos != null);

group('board ingest — failure modes are surfaced, not swallowed');
const blurry = toProposal(
  { legible: false, note: 'Too blurry to read.', course_label: '', divisions: [], new_marks: [], unmatched: [] },
  course, 'D2');
ok('blurry board reports a problem', blurry.problems.length === 1 && /blurry/i.test(blurry.problems[0]));
ok('blurry board proposes nothing', blurry.divisions.length === 0);

const badCoord = toProposal(
  { legible: true, note: '', course_label: '', divisions: [],
    new_marks: [{ label: 'X9', coords: 'somewhere near the seaway', side: 'P' }], unmatched: [] },
  course, 'D2');
ok('unreadable coordinates become a problem',
  badCoord.problems.some(p => /could not read those coordinates/.test(p)), badCoord.problems.join('; '));
ok('unreadable coordinates are not invented', badCoord.newMarks.length === 0);

const unknownMark = toProposal(
  { legible: true, note: '', course_label: '', divisions: [
      { division: 'Division 2', legs: [{ mark: 'A', side: 'P' }, { mark: 'ZZ', side: 'P' }] }],
    new_marks: [], unmatched: ['something illegible'] },
  course, 'D2');
ok('unknown mark reported', unknownMark.problems.some(p => /"ZZ" is not a known mark/.test(p)),
  unknownMark.problems.join('; '));
ok('unmatched text reported', unknownMark.problems.some(p => /something illegible/.test(p)));
ok('the legs that did resolve are kept', unknownMark.divisions[0].legs.length === 1);

group('division selection');
const d1 = toProposal(boardData, course, 'D1');
ok('Division 1 selected for D1', d1.suggested.division === 'Division 1');
const ircBoard = { ...boardData, divisions: [
  { division: 'IRC Super Series', legs: [{ mark: 'A', side: 'P' }] },
  { division: 'Division 2', legs: [{ mark: 'B', side: 'P' }] }] };
ok('IRC matched by name', toProposal(ircBoard, course, 'IRC').suggested.division === 'IRC Super Series');
ok('no guess when nothing matches', toProposal(ircBoard, course, 'D1').suggested === null);
const single = toProposal(
  { ...boardData, divisions: [{ division: 'All divisions', legs: [{ mark: 'A', side: 'P' }] }] },
  course, 'D2');
ok('a single-division board is selected regardless', single.suggested.division === 'All divisions');

group('track codec round-trips at full precision');
const buf = new ArrayBuffer(FIX_BYTES * 3);
const view = new DataView(buf);
const fixes = [
  { lat: -28.186667, lon: 153.571667, dt: 0, sog: 7.53, cog: 157.2, acc: 4, flags: 0 },
  { lat: -27.94, lon: 153.453833, dt: 21_600_000, sog: 0, cog: 359.9, acc: null, flags: FLAG_ROUNDED },
  { lat: 0, lon: 0, dt: 4294967295, sog: 655.35, cog: 360, acc: 65534, flags: FLAG_MANUAL },
];
fixes.forEach((f, i) => encodeFix(view, i, f));
fixes.forEach((f, i) => {
  const d = decodeFix(view, i);
  ok(`fix ${i} lat`, Math.abs(d.lat - f.lat) < 1e-7, `${d.lat} vs ${f.lat}`);
  ok(`fix ${i} lon`, Math.abs(d.lon - f.lon) < 1e-7, `${d.lon} vs ${f.lon}`);
  ok(`fix ${i} dt`, d.dt === f.dt);
  ok(`fix ${i} sog`, Math.abs(d.sog - f.sog) < 0.01);
  ok(`fix ${i} cog`, Math.abs(d.cog - f.cog) < 0.05, `${d.cog} vs ${f.cog}`);
  ok(`fix ${i} acc`, d.acc === f.acc, `${d.acc} vs ${f.acc}`);
  ok(`fix ${i} flags`, d.flags === f.flags);
});

group('storage arithmetic the UI quotes');
const perHour = FIX_BYTES * 3600;
ok('20 bytes per fix', FIX_BYTES === 20);
ok('72 KB per hour at 1 Hz', perHour === 72000, String(perHour));
const passageLimitH = pack.rules.time_limits.Passage.race_h;
ok('passage race limit is 6 h', passageLimitH === 6);
const worstRace = perHour * passageLimitH;
ok('a full passage race is under half a megabyte', worstRace < 512 * 1024,
  (worstRace / 1024).toFixed(0) + ' KB');
const season = perHour * passageLimitH * pack.schedule.length;
ok('a 17-day season is single-digit MB', season / 1024 / 1024 < 10,
  (season / 1024 / 1024).toFixed(1) + ' MB');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
