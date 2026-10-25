// node app/share.test.mjs
import fs from 'node:fs';
import { Course } from './race.js';
import {
  encodeCourse, courseLink, decodeCourse, toSharedProposal, applySharedCourse, checksum,
} from './share.js';
import { describeLegs } from './ingest.js';
import { distM } from './geo.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) pass++; else { fail++; console.log('  FAIL ' + n + (extra ? '  — ' + extra : '')); }
};
const group = n => console.log('\n' + n);

const pack = JSON.parse(fs.readFileSync(new URL('../data/syc-offshore-2627.json', import.meta.url)));

function cookIsland() {
  const c = new Course(pack, { courseId: 'X1', division: 'D2' });
  c.legs = [
    { markId: 'A', side: 'P' }, { markId: 'C', side: 'P' }, { markId: 'D', side: 'P' },
    { markId: 'C', side: 'S' }, { markId: 'A', side: 'S' },
  ];
  return c;
}

group('round trip');
const src = cookIsland();
const enc = encodeCourse(src, { name: 'Cook Island Yacht Race', crew: true });
ok('encodes to a compact string', enc.length < 400, enc.length + ' chars');
ok('carries a checksum', /\.[0-9a-z]{7}$/.test(enc), enc.slice(-10));

const dec = decodeCourse('#c=' + enc);
ok('decodes', dec.ok === true, dec.error);
const dst = new Course(pack, {});
const prop = toSharedProposal(dec.data, dst);
ok('no problems', prop.problems.length === 0, prop.problems.join('; '));
ok('name survives', prop.name === 'Cook Island Yacht Race');
ok('division survives', prop.division === 'D2');
ok('crew flag survives', prop.crew === true);
ok('five legs', prop.legs.length === 5);
applySharedCourse(dst, prop);
ok('legs identical', JSON.stringify(dst.legs) === JSON.stringify(src.legs),
  JSON.stringify(dst.legs));
ok('sides preserved exactly',
  dst.legs.map(l => l.side).join('') === 'PPPSS', dst.legs.map(l => l.side).join(''));
ok('course reads the same',
  describeLegs(dst, dst.legs) === describeLegs(src, src.legs), describeLegs(dst, dst.legs));
ok('sequence resolves', dst.sequence().every(w => w.pos));
ok('same length', Math.abs(dst.lengthNm() - src.lengthNm()) < 1e-9);

group('a whole link');
const link = courseLink(src, { name: 'Cook Island Yacht Race', crew: true, baseUrl: 'https://example.test/race.html' });
ok('uses the fragment, not the query string', link.includes('#c=') && !link.includes('?c='), link.slice(0, 60));
ok('nothing before the hash but the page', link.split('#')[0] === 'https://example.test/race.html');
ok('short enough for a chat message', link.length < 500, link.length + ' chars');
ok('url-safe only', /^[A-Za-z0-9:/._~#=-]+$/.test(link), link.replace(/[A-Za-z0-9:/._~#=-]/g, ''));
ok('decodes from the full link', decodeCourse(link.split('#')[1]).ok === true);

group('marks added on the water travel with it');
const withNew = cookIsland();
withNew.addLocalMark({ id: 'M5', name: 'RC laid mark', lat: -28.0505, lon: 153.5209 });
withNew.legs.splice(2, 0, { markId: 'M5', side: 'S' });
const p2 = toSharedProposal(decodeCourse(encodeCourse(withNew, {})).data, new Course(pack, {}));
ok('new mark carried', p2.localMarks.length === 1 && p2.localMarks[0].id === 'M5');
ok('position carried to centimetres',
  distM(p2.localMarks[0], { lat: -28.0505, lon: 153.5209 }) < 0.02,
  distM(p2.localMarks[0], { lat: -28.0505, lon: 153.5209 }).toFixed(4) + ' m');
ok('its name carried', p2.localMarks[0].name === 'RC laid mark');
ok('six legs', p2.legs.length === 6);
ok('no problems', p2.problems.length === 0, p2.problems.join('; '));
const dst2 = new Course(pack, {});
applySharedCourse(dst2, p2);
ok('the new mark resolves on the receiving side', dst2.sequence()[3].pos != null);
ok('and is flagged as not from the SIs', dst2.markById('M5').local === true);

group('a pinned start line travels');
const pinned = cookIsland();
pinned.lineEnds = [{ lat: -27.9405, lon: 153.4530 }, { lat: -27.9395, lon: 153.4546 }];
const p3 = toSharedProposal(decodeCourse(encodeCourse(pinned, {})).data, new Course(pack, {}));
ok('both ends carried', p3.lineEnds.length === 2);
ok('first end accurate', distM(p3.lineEnds[0], pinned.lineEnds[0]) < 0.02);

group('damaged links fail loudly rather than loading a wrong course');
const full = encodeCourse(src, { name: 'Cook Island Yacht Race' });
// the failure that actually happens: a chat client cuts the URL short
for (const cut of [5, 20, 60, 100]) {
  const r = decodeCourse('#c=' + full.slice(0, full.length - cut));
  ok(`truncated by ${cut} chars is rejected`, r.ok === false, 'it was accepted');
  if (!r.ok) ok(`  ...and says so plainly`, /damaged|incomplete|could not be read/i.test(r.error), r.error);
}
// a single flipped character
const flipped = full.slice(0, 10) + (full[10] === 'A' ? 'B' : 'A') + full.slice(11);
ok('a single corrupted character is rejected', decodeCourse('#c=' + flipped).ok === false);
// checksum stripped
ok('a link with no checksum is rejected', decodeCourse('#c=' + full.split('.')[0]).ok === false);
// wrong checksum
ok('a wrong checksum is rejected', decodeCourse('#c=' + full.split('.')[0] + '.zzzzzzz').ok === false);
ok('empty is rejected', decodeCourse('').ok === false);
ok('junk is rejected', decodeCourse('#c=not-a-course').ok === false);
ok('a bare hash is ignored', decodeCourse('#').ok === false);

group('chat clients mangle the end of URLs');
for (const suffix of [')', '.', ',', '")', ');', "'"]) {
  const r = decodeCourse('#c=' + full + suffix);
  ok(`trailing "${suffix}" tolerated`, r.ok === true, r.error);
}

group('a link from a different pack is refused, not guessed at');
const other = decodeCourse('#c=' + encodeCourse(src, {}));
other.data.p = 'some-other-club-2027';
const p4 = toSharedProposal(other.data, new Course(pack, {}));
ok('mismatch flagged', p4.packMismatch === true);
ok('nothing loaded', p4.legs.length === 0);
ok('names both packs', /some-other-club-2027/.test(p4.problems[0]) && /syc-offshore/.test(p4.problems[0]),
  p4.problems[0]);

group('a future format version is refused');
const v2 = decodeCourse('#c=' + encodeCourse(src, {}));
v2.data.v = 99;
const reEnc = Buffer.from(JSON.stringify(v2.data)).toString('base64url');
const r99 = decodeCourse('#c=' + reEnc + '.' + checksum(reEnc));
ok('rejected', r99.ok === false);
ok('tells the user to update', /version/i.test(r99.error), r99.error);

group('an unknown mark in a shared course is reported, not silently dropped');
const bad = decodeCourse('#c=' + encodeCourse(src, {}));
bad.data.l.splice(2, 0, ['ZZ', 'P']);
const p5 = toSharedProposal(bad.data, new Course(pack, {}));
ok('reported', p5.problems.some(p => /"ZZ"/.test(p)), p5.problems.join('; '));
ok('the rest still loads', p5.legs.length === 5);

group('an impossible coordinate is dropped and reported');
const wild = decodeCourse('#c=' + encodeCourse(withNew, {}));
wild.data.m[0][2] = 999;
const p6 = toSharedProposal(wild.data, new Course(pack, {}));
ok('mark dropped', p6.localMarks.length === 0);
ok('and the leg that needed it is reported',
  p6.problems.length >= 2 && p6.problems.some(x => /impossible position/.test(x)),
  p6.problems.join('; '));

group('checksum behaviour');
ok('stable', checksum('hello') === checksum('hello'));
ok('differs on one character', checksum('hello') !== checksum('hellp'));
ok('fixed width', checksum('a').length === 7 && checksum('a much longer string here').length === 7);

group('a long passage course still fits in a link');
const long = new Course(pack, { courseId: 'X1', division: 'D2' });
long.legs = ['A', 'B', 'C', 'D', 'S', 'C', 'B', 'A', 'N', 'SW', 'M', 'MSW', 'F1', 'A']
  .map((m, i) => ({ markId: m, side: i % 2 ? 'S' : 'P' }));
const longLink = courseLink(long, { name: 'A very long passage race', baseUrl: 'https://example.test/race.html' });
ok('14 marks still fits comfortably', longLink.length < 700, longLink.length + ' chars');
const pl = toSharedProposal(decodeCourse(longLink.split('#')[1]).data, new Course(pack, {}));
ok('and round trips', pl.legs.length === 14 && pl.problems.length === 0, pl.problems.join('; '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
