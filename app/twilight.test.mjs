// node app/twilight.test.mjs
//
// Sails a simulated Thursday Twilight through the real SYC Twilight pack and
// checks what that pack exercises for the first time: published courses that
// differ by division, and a finish line that is not the start line.

import fs from 'node:fs';
import { Course, RoundingEngine, PROX_NM } from './race.js';
import { distNm, brgTo, movePt } from './geo.js';
import { FLAG_ROUNDED, FLAG_FINISH } from './store.js';
import { encodeCourse, decodeCourse, toSharedProposal, applySharedCourse } from './share.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL ' + name + (extra ? '  — ' + extra : '')); }
};
const group = n => console.log('\n' + n);

const pack = JSON.parse(fs.readFileSync(new URL('../data/syc-twilight-2627.json', import.meta.url)));

group('pack integrity');
ok('pack id', pack.id === 'syc-twilight-2627');
ok('10 marks', pack.marks.length === 10, String(pack.marks.length));
ok('4 published lines', pack.marks.filter(m => m.kind === 'line').length === 4);
ok('every mark has a position', pack.marks.every(m => m.lat != null && m.lon != null));
ok('no quadrants — the TT SIs define none', pack.marks.every(m => !m.quadrants));
ok('15 courses', pack.courses.length === 15, String(pack.courses.length));
ok('14 pursuit courses with per-division marks',
  pack.courses.filter(c => c.type === 'PURSUIT' && c.div && c.div.D1 && c.div.D2).length === 14);
ok('course 15 is the offshore builder', pack.courses.find(c => c.id === '15').builder === true);
ok('default rounding is port', pack.rules.default_rounding === 'P');
ok('no declaration SI — TT has no 20.8', !pack.rules.declaration_si);
ok('pursuit prep signal is 4 min', pack.rules.prep_signal_sec === 240);
ok('Wonder Reef zone present', !!pack.zones.find(z => z.id === 'wonder-reef'));
ok('42 race days', pack.schedule.length === 42, String(pack.schedule.length));
ok('every race day is a Thursday',
  pack.schedule.every(s => new Date(s.date + 'T12:00:00Z').getUTCDay() === 4),
  pack.schedule.filter(s => new Date(s.date + 'T12:00:00Z').getUTCDay() !== 4).map(s => s.date).join(','));

group('every published course resolves against the pack');
const markIds = new Set(pack.marks.map(m => m.id));
const lineIds = new Set(pack.marks.filter(m => m.kind === 'line').map(m => m.id));
for (const c of pack.courses) {
  if (c.builder) continue;
  ok(`course ${c.id} starts on a line`, lineIds.has(c.start), c.start);
  ok(`course ${c.id} finishes on a line`, lineIds.has(c.finish), c.finish);
  for (const [div, d] of Object.entries(c.div)) {
    ok(`course ${c.id} ${div} marks exist`, d.seq.every(([id]) => markIds.has(id)),
      d.seq.map(([id]) => id).join(','));
    ok(`course ${c.id} ${div} sides are P/S`, d.seq.every(([, s]) => s === 'P' || s === 'S'));
  }
}

group('course 1, Division 2 — start and finish are different lines');
const c1 = pack.courses.find(c => c.id === '1');
const course = new Course(pack, { courseId: '1', division: 'D2' });
course.legs = c1.div.D2.seq.map(([markId, side]) => ({ markId, side }));
course.startId = c1.start;
course.finishId = c1.finish;
ok('D1 and D2 sail different courses',
  JSON.stringify(c1.div.D1.seq) !== JSON.stringify(c1.div.D2.seq));
const seq = course.sequence();
ok('start + 5 marks + finish', seq.length === 7, String(seq.length));
ok('starts at WBS1', seq[0].id === 'WBS1');
ok('finishes at WBF', seq[6].id === 'WBF');
ok('start and finish are apart', distNm(seq[0].pos, seq[6].pos) > 0.5,
  distNm(seq[0].pos, seq[6].pos).toFixed(2) + ' nm');
ok('finishesAtStart is false', course.finishesAtStart() === false);
// The SI calls this course "5.5 nm approx", but the straight-line distance
// between its own published coordinates is ~8 nm — the coordinates are the
// authoritative data, so only plausibility is asserted here.
const nm = course.lengthNm();
ok('straight-line length is plausible', nm > 4 && nm < 10, nm.toFixed(1) + ' nm');

group('sailing it — proximity rounding, finish at the right line');
function sail(engine, crs) {
  const log = [];
  let prev = null;
  let boat = { ...crs.startPos() };
  let guard = 0;
  while (!engine.done() && guard++ < 4000) {
    const wp = engine.current();
    if (!wp || !wp.pos) break;
    const d = distNm(boat, wp.pos);
    const step = Math.min(0.02, Math.max(0.004, d));
    boat = movePt(boat, brgTo(boat, wp.pos), step);
    boat.sog = 5.5; boat.cog = brgTo(prev || boat, boat); boat.acc = 6;
    const evs = engine.step(boat, prev, 1_760_000_000_000 + guard * 1000);
    for (const e of evs) log.push(e);
    prev = { ...boat };
    if (d < step * 1.1 && !evs.length) { ok('sail did not stall at ' + wp.label, false); break; }
  }
  return log;
}

const eng = new RoundingEngine(course);
const log = sail(eng, course);
const rounds = log.filter(e => e.flag === FLAG_ROUNDED);
const finishes = log.filter(e => e.flag === FLAG_FINISH);
ok('five marks rounded then the finish', log.length === 6, `${log.length}: ` + log.map(e => e.id).join(','));
ok('rounded in course order', rounds.map(e => e.id).join(',') === 'C,J,C,E,H', rounds.map(e => e.id).join(','));
ok('all by proximity — no quadrants to claim', rounds.every(e => e.how === 'proximity'),
  log.map(e => e.how).join(','));
ok('finish recorded at WBF', finishes.length === 1 && finishes[0].id === 'WBF');
ok('course is complete', eng.done() && eng.finishedAt != null);
const wbf = pack.marks.find(m => m.id === 'WBF');
ok('finish fix is at the finish line, not the start',
  distNm(finishes[0].fix, wbf) < PROX_NM * 1.5, distNm(finishes[0].fix, wbf).toFixed(3) + ' nm from WBF');

group('a pinned start line is not evidence of finishing elsewhere');
const pinned = new Course(pack, { courseId: '1', division: 'D2', startId: 'WBS1', finishId: 'WBF' });
pinned.legs = [{ markId: 'C', side: 'P' }];
const sp = pinned.startPos();
pinned.lineEnds = [movePt(sp, 90, 0.05), movePt(sp, 270, 0.05)];
const eng2 = new RoundingEngine(pinned);
eng2.wpIdx = 2;                                       // heading for the finish
const before = movePt(sp, 0, 0.05), after = movePt(sp, 180, 0.05);
const crossed = eng2.step(after, before, 1_760_000_000_000);
ok('crossing the pinned start line does not finish', crossed.length === 0,
  crossed.map(e => e.id).join(','));
const nearWbf = { lat: wbf.lat, lon: wbf.lon };
const fin2 = eng2.step(nearWbf, after, 1_760_000_000_001);
ok('arriving at WBF does finish', fin2.length === 1 && fin2[0].how === 'proximity');

group('the course link carries the start and finish lines');
const link = encodeCourse(course, {});
const dec = decodeCourse(link);
ok('decodes', dec.ok, dec.error);
const prop = toSharedProposal(dec.data, new Course(pack, {}));
ok('no problems', prop.problems.length === 0, prop.problems.join(' | '));
ok('start line carried', prop.startId === 'WBS1', String(prop.startId));
ok('finish line carried', prop.finishId === 'WBF', String(prop.finishId));
const crewCourse = new Course(pack, {});
applySharedCourse(crewCourse, prop);
ok('crew finishes at WBF too', crewCourse.finishMark().id === 'WBF');
ok('crew start/finish differ', crewCourse.finishesAtStart() === false);

const forged = { ...dec.data, f: 'NOPE' };
const bad = toSharedProposal(forged, new Course(pack, {}));
ok('an unknown finish line is refused, not guessed at',
  bad.finishId === null && bad.problems.some(p => /NOPE/.test(p)), bad.problems.join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
