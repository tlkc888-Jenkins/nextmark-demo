// node app/geo.test.mjs
import {
  distNm, distM, brgTo, movePt, quadrantArc, inArc, pickQuadrant, inQuadrant,
  crossesLine, parseOne, parsePair, fmtDDM, fmtBrg, vmc, brgDiff,
} from './geo.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; } else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};
const near = (name, got, want, tol) => ok(name + ` (${got} ~ ${want})`, Math.abs(got - want) <= tol);
const group = n => console.log('\n' + n);

// Real marks from the SYC Offshore Division 2026/27 SIs, Attachment B.
const SF = { lat: -27.940000, lon: 153.453833 };  // Offshore Start/Finish
const A = { lat: -28.002250, lon: 153.446667 };   // Surfers
const D = { lat: -28.186667, lon: 153.571667 };   // Cook Island
const N = { lat: -27.892667, lon: 153.476833 };   // Northern

group('distance / bearing');
// Start to Surfers is ~3.75 nm; the Sail Paradise course book calls the
// Surfers out-and-back 7.7 nm, i.e. 3.85 each way.
near('SF->A nm', distNm(SF, A), 3.75, 0.1);
near('SF->A m', distM(SF, A), 6945, 200);
ok('zero distance', distNm(SF, SF) === 0);
// Cook Island lies SSE of the start line: 14.80 nm south, 6.24 nm east of it,
// so atan2(6.24, -14.80) = 157.2 deg true and the range is 16.06 nm.
near('SF->D bearing', brgTo(SF, D), 157.2, 0.3);
near('SF->D nm', distNm(SF, D), 16.06, 0.1);
// Northern Mark: 2.84 nm north, 1.22 nm east -> atan2(1.22, 2.84) = 23.2 deg.
near('SF->N bearing', brgTo(SF, N), 23.2, 0.3);
ok('reciprocal', Math.abs(brgDiff(brgTo(SF, D), brgTo(D, SF)) - 180) < 1);

group('movePt round trip');
// Walking the computed bearing and range from the start line must land on the
// Cook Island Mark, which closes the loop on distNm/brgTo/movePt together.
const moved = movePt(SF, brgTo(SF, D), distNm(SF, D));
near('movePt lat', moved.lat, D.lat, 1e-6);
near('movePt lon', moved.lon, D.lon, 1e-6);
for (const b of [0, 45, 90, 180, 270, 359]) {
  const p = movePt(SF, b, 0.8);
  near(`movePt ${b} back-bearing`, brgTo(SF, p), b, 0.5);
  near(`movePt ${b} distance`, distNm(SF, p), 0.8, 0.001);
}

group('SI 10.7 quadrant arcs');
// "180 and 270 when heading in a Southerly direction" -> the SW quadrant.
ok('180/270 -> [180,270]', JSON.stringify(quadrantArc(180, 270)) === '[180,270]');
// "0 and 270 when heading in a Northerly direction" -> the NW quadrant,
// which is 270 clockwise to 360 — NOT 0 clockwise to 270.
ok('0/270 -> [270,0]', JSON.stringify(quadrantArc(0, 270)) === '[270,0]');
ok('270/0 -> [270,0]', JSON.stringify(quadrantArc(270, 0)) === '[270,0]');
ok('90/180 -> [90,180]', JSON.stringify(quadrantArc(90, 180)) === '[90,180]');
ok('SW arc holds 225', inArc(225, 180, 270));
ok('SW arc rejects 90', !inArc(90, 180, 270));
ok('NW arc holds 315', inArc(315, 270, 0));
ok('NW arc rejects 45', !inArc(45, 270, 0));
ok('NW arc holds 270 edge', inArc(270, 270, 0));
ok('NW arc holds 359', inArc(359, 270, 0));

group('quadrant selection by leg direction');
const COASTAL = [
  { dir: 'S', b1: 180, b2: 270 },
  { dir: 'N', b1: 0, b2: 270 },
];
const ANY_SW = [{ dir: '*', b1: 180, b2: 270 }];
ok('southbound leg picks S', pickQuadrant(COASTAL, 170).dir === 'S');
ok('southbound leg 200 picks S', pickQuadrant(COASTAL, 200).dir === 'S');
ok('northbound leg 10 picks N', pickQuadrant(COASTAL, 10).dir === 'N');
ok('northbound leg 350 picks N', pickQuadrant(COASTAL, 350).dir === 'N');
ok('"*" wins regardless', pickQuadrant(ANY_SW, 10).dir === '*');
ok('no quadrants -> null', pickQuadrant([], 10) === null);
ok('no quadrants -> null (undef)', pickQuadrant(undefined, 10) === null);

group('rounding Surfers Mark southbound (leave to port)');
// Sailing south with Surfers to port means passing inshore (west) of it and
// exiting to the south-west, which is exactly the published quadrant.
const quadS = pickQuadrant(COASTAL, brgTo(SF, A));   // leg SF -> A heads ~185
ok('leg SF->A is southerly', quadS.dir === 'S');
const swOfA = movePt(A, 225, 0.05);                  // 50 m SW of the mark
const neOfA = movePt(A, 45, 0.05);                   // wrong side
ok('fix SW of A counts', inQuadrant(A, swOfA, quadS, 0.2));
ok('fix NE of A does not', !inQuadrant(A, neOfA, quadS, 0.2));
// A fix on the right bearing but 5 nm away is not a rounding.
const farSW = movePt(A, 225, 5);
ok('far SW fix rejected by radius', !inQuadrant(A, farSW, quadS, 0.2));

group('rounding Surfers Mark northbound (leave to starboard)');
const quadN = pickQuadrant(COASTAL, brgTo(A, SF));   // leg A -> SF heads ~005
ok('leg A->SF is northerly', quadN.dir === 'N');
const nwOfA = movePt(A, 315, 0.05);
ok('fix NW of A counts', inQuadrant(A, nwOfA, quadN, 0.2));
ok('fix SW of A does not (northbound)', !inQuadrant(A, swOfA, quadN, 0.2));

group('Cook Island Mark — single published quadrant, any direction');
const quadD = pickQuadrant(ANY_SW, brgTo(SF, D));
const swOfD = movePt(D, 200, 0.04);
const eOfD = movePt(D, 90, 0.04);
ok('fix SW of D counts', inQuadrant(D, swOfD, quadD, 0.2));
ok('fix E of D does not', !inQuadrant(D, eOfD, quadD, 0.2));
// same quadrant applies on the way home
ok('same quadrant northbound', pickQuadrant(ANY_SW, brgTo(D, SF)).b1 === 180);

group('start / finish line crossing');
// A 100 m line across the course, boat crossing it northbound.
const pin = movePt(SF, 270, 0.027);   // port end, ~50 m west
const boat = movePt(SF, 90, 0.027);   // starboard end, ~50 m east
const before = movePt(SF, 180, 0.02);
const after = movePt(SF, 0, 0.02);
const x = crossesLine(before, after, pin, boat);
ok('crossing detected', x !== null);
ok('crossing t within 0..1', x && x.t > 0 && x.t < 1);
const back = crossesLine(after, before, pin, boat);
ok('reverse crossing detected', back !== null);
ok('reverse crossing has opposite sign', back && x && Math.sign(back.side) === -Math.sign(x.side));
ok('no crossing when short', crossesLine(before, movePt(SF, 180, 0.01), pin, boat) === null);
ok('no crossing when wide of the line', crossesLine(
  movePt(movePt(SF, 90, 0.2), 180, 0.02),
  movePt(movePt(SF, 90, 0.2), 0, 0.02), pin, boat) === null);

group('coordinate parsing — the SI / VHF format');
near('SI lat 27 56.400 S', parseOne('27 56.400 S', 'lat'), -27.94, 1e-9);
near('SI lon 153 27.230 E', parseOne('153 27.230 E', 'lon'), 153.453833, 1e-5);
near('Cook lat 28 11.200 S', parseOne('28 11.200 S', 'lat'), -28.186667, 1e-5);
near('Cook lon 153 34.300 E', parseOne('153 34.300 E', 'lon'), 153.571667, 1e-5);
near('with degree symbols', parseOne("28°11.200'S", 'lat'), -28.186667, 1e-5);
near('leading hemisphere', parseOne('S 28 11.200', 'lat'), -28.186667, 1e-5);
near('comma decimal', parseOne('28 11,200 S', 'lat'), -28.186667, 1e-5);
near('decimal degrees', parseOne('-28.186667', 'lat'), -28.186667, 1e-9);
near('DMS', parseOne('28 11 12 S', 'lat'), -(28 + 11 / 60 + 12 / 3600), 1e-9);
ok('rejects minutes >= 60', parseOne('28 61.0 S', 'lat') === null);
ok('rejects lat > 90', parseOne('91 00.0 N', 'lat') === null);
ok('rejects lon > 180', parseOne('181 00.0 E', 'lon') === null);
ok('rejects E for a latitude', parseOne('153 27.230 E', 'lat') === null);
ok('rejects N for a longitude', parseOne('27 56.400 N', 'lon') === null);
ok('rejects junk', parseOne('somewhere out there', 'lat') === null);
ok('rejects empty', parseOne('', 'lat') === null);

group('coordinate parsing — whole positions');
const p1 = parsePair('28 11.200 S 153 34.300 E');
near('pair lat', p1.lat, -28.186667, 1e-5);
near('pair lon', p1.lon, 153.571667, 1e-5);
const p2 = parsePair('-28.186667, 153.571667');
near('decimal pair lat', p2.lat, -28.186667, 1e-9);
near('decimal pair lon', p2.lon, 153.571667, 1e-9);
const p3 = parsePair("28°11.200′S, 153°34.300′E");
near('symbol pair lat', p3.lat, -28.186667, 1e-5);
const p4 = parsePair('-28.1867 153.5717');
near('space pair lat', p4.lat, -28.1867, 1e-9);
const p5 = parsePair('28 11.200 S / 153 34.300 E');
near('slash pair lat', p5.lat, -28.186667, 1e-5);
ok('pair rejects junk', parsePair('no idea') === null);
ok('pair rejects single axis', parsePair('28 11.200 S') === null);

group('formatting');
ok('fmtDDM matches the SI', fmtDDM(-28.186667, 153.571667) === '28°11.200′S 153°34.300′E',
  fmtDDM(-28.186667, 153.571667));
ok('fmtDDM start line', fmtDDM(-27.94, 153.453833) === '27°56.400′S 153°27.230′E',
  fmtDDM(-27.94, 153.453833));
ok('fmtBrg pads', fmtBrg(5) === '005');
ok('fmtBrg wraps 360', fmtBrg(360) === '000');
ok('fmtBrg wraps 365', fmtBrg(365) === '005');

group('round trip: every SI mark survives format -> parse');
const SI_MARKS = [
  ['SF', -27.940000, 153.453833], ['A', -28.002250, 153.446667],
  ['B', -28.085000, 153.463333], ['C', -28.121667, 153.491667],
  ['D', -28.186667, 153.571667], ['F1', -27.988833, 153.529167],
  ['M', -28.043267, 153.454883], ['MSW', -28.043217, 153.491733],
  ['N', -27.892667, 153.476833], ['S', -28.155500, 153.550000],
  ['SW', -27.963417, 153.475600],
];
for (const [id, lat, lon] of SI_MARKS) {
  const rt = parsePair(fmtDDM(lat, lon));
  ok(`${id} round trips`, rt && distM({ lat, lon }, rt) < 2,
    rt ? distM({ lat, lon }, rt).toFixed(2) + ' m' : 'unparsed');
}

group('vmc');
near('vmc straight at it', vmc(7.5, 180, 180), 7.5, 1e-9);
near('vmc 60 off', vmc(7.5, 120, 180), 3.75, 1e-9);
near('vmc abeam', vmc(7.5, 90, 180), 0, 1e-9);
near('vmc sailing away', vmc(7.5, 0, 180), -7.5, 1e-9);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
