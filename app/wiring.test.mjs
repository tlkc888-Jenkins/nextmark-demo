// node app/wiring.test.mjs
//
// Catches the bug class that only shows up when you tap the thing: an id the
// script reaches for that the markup never defined. Also parses every module
// and checks the imports resolve.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) pass++; else { fail++; console.log('  FAIL ' + n + (extra ? '  — ' + extra : '')); }
};

const html = fs.readFileSync(path.join(root, 'race.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'app', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app', 'app.css'), 'utf8');

console.log('\nids referenced by app.js exist in race.html');
const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
const used = new Set([...js.matchAll(/\bel\((['"])([^'"]+)\1\)/g)].map(m => m[2]));
ok(`${htmlIds.size} ids in markup, ${used.size} referenced`, htmlIds.size > 0 && used.size > 0);
for (const id of [...used].sort()) {
  ok(`#${id}`, htmlIds.has(id), 'referenced by app.js but not in race.html');
}

console.log('\nids in the markup are actually used (dead markup check)');
// Some ids reach el() through a local helper (set('brg', …)) rather than as a
// literal el('brg'), so count any quoted occurrence of the id in the script.
const quoted = new Set([...js.matchAll(/(['"])([A-Za-z][\w-]*)\1/g)].map(m => m[2]));
const alsoReferenced = new Set([
  ...[...js.matchAll(/getElementById\((['"])([^'"]+)\1\)/g)].map(m => m[2]),
]);
for (const id of [...htmlIds].sort()) {
  const inJs = used.has(id) || alsoReferenced.has(id) || quoted.has(id);
  const inHtml = new RegExp(`(for|aria-labelledby|href)="#?${id}"`).test(html);
  ok(`#${id} is used`, inJs || inHtml, 'defined in race.html but never referenced');
}

console.log('\ndata-panel and data-tab attributes line up');
const panels = new Set([...html.matchAll(/data-panel="([^"]+)"/g)].map(m => m[1]));
const tabs = new Set([...html.matchAll(/data-tab="([^"]+)"/g)].map(m => m[1]));
for (const t of tabs) ok(`tab "${t}" has a panel`, panels.has(t));
for (const p of panels) ok(`panel "${p}" has a tab`, tabs.has(p));

console.log('\nclasses the script toggles exist in the stylesheet');
const toggled = new Set([
  ...[...js.matchAll(/classList\.(?:toggle|add|remove)\((['"])([^'"\s]+)\1/g)].map(m => m[2]),
]);
for (const c of [...toggled].sort()) {
  ok(`.${c} is styled`, new RegExp(`\\.${c}\\b`).test(css), 'toggled by app.js but has no CSS rule');
}

console.log('\nevery module parses and its imports resolve');
const modules = fs.readdirSync(path.join(root, 'app')).filter(f => f.endsWith('.js'));
ok('found the modules', modules.length >= 6, modules.join(','));
for (const m of modules) {
  const src = fs.readFileSync(path.join(root, 'app', m), 'utf8');
  // every relative import must point at a file that exists
  for (const mm of src.matchAll(/from\s+'(\.\/[^']+)'/g)) {
    const target = path.join(root, 'app', mm[1]);
    ok(`${m} imports ${mm[1]}`, fs.existsSync(target), 'missing file');
  }
  try {
    await import(new URL('./' + m, import.meta.url).href);
    pass++;
  } catch (e) {
    // modules that touch the DOM at import time are expected to fail here;
    // a syntax error is not.
    if (/document|window|navigator|HTMLElement/.test(String(e.message))) pass++;
    else { fail++; console.log(`  FAIL ${m} does not load — ${e.message}`); }
  }
}

console.log('\ndata files referenced by the code are present');
for (const rel of ['data/syc-offshore-2627.json', 'data/syc-twilight-2627.json',
  'data/coast-world.json', 'data/coast-syc.json']) {
  ok(rel, fs.existsSync(path.join(root, rel)));
}
for (const f of ['manifest.json', 'sw.js', 'icon-192.png', 'icon-512.png']) {
  ok(f, fs.existsSync(path.join(root, f)));
}

console.log('\nservice worker caches everything the app needs offline');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
for (const need of [
  'race.html', 'app/app.js', 'app/app.css', 'app/geo.js', 'app/store.js',
  'app/race.js', 'app/chart.js', 'app/coast.js', 'app/ingest.js',
  'data/syc-offshore-2627.json', 'data/syc-twilight-2627.json',
  'data/coast-world.json', 'data/coast-syc.json',
]) {
  ok(`sw caches ${need}`, sw.includes(need), 'not in the service worker shell list');
}

console.log('\nmanifest points at the race screen');
const mf = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
ok('start_url is the app', /race\.html/.test(mf.start_url), mf.start_url);
ok('display is standalone', mf.display === 'standalone', mf.display);
ok('has icons', Array.isArray(mf.icons) && mf.icons.length >= 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
