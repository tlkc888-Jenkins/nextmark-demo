// Briefing ingest: photograph the course board, keep it on the device, and
// optionally have it read into a course you confirm before it goes on the chart.
//
// The course for a Sunday offshore passage race is course X1 — "a course set by
// the Race Committee as advised at the Compulsory Skippers Briefing" — so the
// board photographed at 09:00 is the only place the day's course exists. Three
// things follow from that:
//
//  1. The photo itself is the valuable artefact. It is stored on the device so
//     it can be pinched and zoomed on deck with no signal, which is strictly
//     better than a wet piece of paper even if nothing reads it.
//  2. Reading it is a convenience, never a dependency. The course builder works
//     with no key, no signal and no AI.
//  3. Nothing read from a photo is ever applied silently. An extraction produces
//     a *proposal* that is shown against what is currently loaded; only an
//     explicit confirm puts it on the chart.

import { parsePair } from './geo.js';
import { getSetting, setSetting } from './store.js';

const DEFAULT_MODEL = 'claude-opus-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/** Longest edge we upload. Keeps a phone photo well inside the token budget. */
const MAX_EDGE = 1600;

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

/**
 * Downscale and re-encode a captured photo.
 *
 * A modern phone camera produces 4000 px JPEGs; a course board is legible at
 * 1600 px and costs a fraction of the tokens and the storage. The original is
 * never needed again, so only the downscaled version is kept.
 */
export async function preparePhoto(file) {
  const bitmap = await loadBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d');
  g.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.82));
  return { blob, width: w, height: h, bytes: blob.size, type: 'image/jpeg' };
}

async function loadBitmap(file) {
  if (globalThis.createImageBitmap) {
    try { return await createImageBitmap(file); } catch { /* fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res; img.onerror = () => rej(new Error('could not read that image'));
      img.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

async function blobToBase64(blob) {
  const url = await blobToDataUrl(blob);
  return url.slice(url.indexOf(',') + 1);
}

// ---------------------------------------------------------------------------
// settings for the optional read
// ---------------------------------------------------------------------------

export async function readerSettings() {
  return {
    apiKey: await getSetting('apiKey', ''),
    proxyUrl: await getSetting('proxyUrl', ''),
    model: await getSetting('model', DEFAULT_MODEL),
  };
}

export async function saveReaderSettings({ apiKey, proxyUrl, model }) {
  if (apiKey !== undefined) await setSetting('apiKey', apiKey.trim());
  if (proxyUrl !== undefined) await setSetting('proxyUrl', proxyUrl.trim());
  if (model !== undefined) await setSetting('model', (model || '').trim() || DEFAULT_MODEL);
}

export async function readerAvailable() {
  const s = await readerSettings();
  return !!(s.apiKey || s.proxyUrl);
}

// ---------------------------------------------------------------------------
// the extraction schema
//
// Structured outputs pin the shape, so the response is either a valid course
// proposal or an error — there is no partially-parsed middle state to handle on
// a boat. Unknown marks come back in `unmatched` rather than being guessed at.
// ---------------------------------------------------------------------------

export function boardSchema(markIds) {
  return {
    type: 'object',
    properties: {
      legible: {
        type: 'boolean',
        description: 'False if the image is too blurry, dark or cropped to read a course from.',
      },
      note: {
        type: 'string',
        description: 'What the board appears to be, or why it could not be read. One sentence.',
      },
      course_label: {
        type: 'string',
        description: 'Any course name or number written on the board, e.g. "X1" or "Course 12". Empty string if none.',
      },
      divisions: {
        type: 'array',
        description: 'One entry per division the board assigns a course to.',
        items: {
          type: 'object',
          properties: {
            division: {
              type: 'string',
              description: 'The division exactly as written, e.g. "Division 1", "Div 2", "IRC".',
            },
            legs: {
              type: 'array',
              description:
                'The marks in the order sailed, excluding start and finish. ' +
                'Use only mark ids from the supplied list.',
              items: {
                type: 'object',
                properties: {
                  mark: { type: 'string', enum: markIds },
                  side: {
                    type: 'string',
                    enum: ['P', 'S'],
                    description: 'P to leave the mark to port, S to starboard. Port unless the board says otherwise.',
                  },
                },
                required: ['mark', 'side'],
                additionalProperties: false,
              },
            },
          },
          required: ['division', 'legs'],
          additionalProperties: false,
        },
      },
      new_marks: {
        type: 'array',
        description: 'Marks written on the board with coordinates that are not in the supplied list.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'The mark name or letter as written.' },
            coords: {
              type: 'string',
              description: 'The position exactly as written on the board, e.g. "28 11.200 S 153 34.300 E".',
            },
            side: { type: 'string', enum: ['P', 'S'] },
          },
          required: ['label', 'coords', 'side'],
          additionalProperties: false,
        },
      },
      unmatched: {
        type: 'array',
        description: 'Anything on the board that looks like a mark but could not be matched to the list.',
        items: { type: 'string' },
      },
    },
    required: ['legible', 'note', 'course_label', 'divisions', 'new_marks', 'unmatched'],
    additionalProperties: false,
  };
}

function boardPrompt(pack, markIds) {
  const table = pack.marks
    .map(m => `  ${m.id} = ${m.name}${m.lat == null ? ' (laid on the day, no fixed position)' : ''}`)
    .join('\n');
  return [
    `This is a photograph of the course board or course sheet for a yacht race run by ${pack.club}.`,
    '',
    'Read the course off it. The marks available are:',
    table,
    '',
    'Rules for reading it:',
    `- ${pack.rules.default_rounding_si}`,
    '- Give the marks in the order they are sailed. Do not include the start or the finish.',
    '- A board may assign different courses to different divisions. Return one entry per division.',
    '- Use only the mark ids listed above. Anything you cannot match goes in "unmatched".',
    '- A mark written with coordinates that is not in the list goes in "new_marks", with the position copied exactly as written.',
    '- Do not infer, complete or correct a course. Report only what is legible on the board.',
    '- If the image cannot be read, set legible to false and say why.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// the read
// ---------------------------------------------------------------------------

/**
 * Send a board photo to be read. Returns {ok, data} or {ok:false, error}.
 *
 * Posts either straight to the Claude API with the user's own key, or to a
 * proxy URL if one is configured. The direct path needs the API to allow a
 * browser origin; if it is refused the error says so and points at the proxy
 * setting, because a CORS failure on the morning of a race needs to be a
 * legible message rather than a silent nothing.
 */
export async function readBoard(blob, pack, opts = {}) {
  const s = await readerSettings();
  if (!s.apiKey && !s.proxyUrl) {
    return { ok: false, error: 'No reader configured. Add an API key in Settings, or build the course by hand.' };
  }
  const markIds = pack.marks.filter(m => m.kind !== 'line').map(m => m.id);
  const b64 = await blobToBase64(blob);

  const body = {
    model: s.model || DEFAULT_MODEL,
    max_tokens: 4096,
    output_config: { format: { type: 'json_schema', schema: boardSchema(markIds) } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
        { type: 'text', text: boardPrompt(pack, markIds) },
      ],
    }],
  };

  const url = s.proxyUrl || API_URL;
  const headers = { 'content-type': 'application/json' };
  if (!s.proxyUrl) {
    headers['x-api-key'] = s.apiKey;
    headers['anthropic-version'] = API_VERSION;
    // Browser calls to the API are an explicit opt-in; without this the
    // request is rejected before it reaches the model.
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal,
    });
  } catch (e) {
    return {
      ok: false,
      network: true,
      error: s.proxyUrl
        ? 'Could not reach the proxy. Check signal, or build the course by hand.'
        : 'Could not reach the API — no signal, or the browser blocked the call. ' +
          'Set a proxy URL in Settings, or build the course by hand.',
    };
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch { /* no body */ }
    if (res.status === 401) return { ok: false, error: 'API key rejected (401). Check it in Settings.' };
    if (res.status === 429) return { ok: false, error: 'Rate limited (429). Wait a moment and try again.' };
    if (res.status >= 500) return { ok: false, error: `API unavailable (${res.status}). Try again, or build the course by hand.` };
    return { ok: false, error: `Read failed (${res.status})${detail ? ': ' + detail : ''}` };
  }

  let msg;
  try { msg = await res.json(); } catch { return { ok: false, error: 'Unreadable response from the API.' }; }

  if (msg.stop_reason === 'refusal') {
    return { ok: false, error: 'The request was declined. Build the course by hand.' };
  }
  const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  if (!text) return { ok: false, error: 'The reader returned nothing. Build the course by hand.' };

  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, error: 'The reader returned something unparseable.' }; }

  return { ok: true, data, usage: msg.usage || null, model: msg.model || body.model };
}

// ---------------------------------------------------------------------------
// turning a read into a proposal the sailor confirms
// ---------------------------------------------------------------------------

/**
 * Convert an extraction into something that can be reviewed and applied.
 *
 * Every leg is resolved against the pack, every new mark's coordinates are
 * re-parsed locally rather than trusted as numbers, and anything that does not
 * resolve becomes a visible problem rather than a silently dropped leg.
 */
export function toProposal(data, course, divisionId) {
  const out = {
    legible: !!data.legible,
    note: data.note || '',
    courseLabel: data.course_label || '',
    divisions: [],
    problems: [],
  };
  if (!data.legible) {
    out.problems.push(data.note || 'The photo could not be read.');
    return out;
  }

  const known = new Set(course.allMarks().map(m => m.id));
  const newMarks = [];
  for (const nm of data.new_marks || []) {
    const pos = parsePair(nm.coords);
    if (!pos) {
      out.problems.push(`"${nm.label}" at "${nm.coords}" — could not read those coordinates. Type them in by hand.`);
      continue;
    }
    newMarks.push({ label: nm.label, id: sanitiseId(nm.label), pos, side: nm.side === 'S' ? 'S' : 'P' });
  }
  out.newMarks = newMarks;

  for (const d of data.divisions || []) {
    const legs = [];
    for (const leg of d.legs || []) {
      if (known.has(leg.mark)) {
        legs.push({ markId: leg.mark, side: leg.side === 'S' ? 'S' : 'P' });
      } else {
        const added = newMarks.find(n => n.id === leg.mark || n.label === leg.mark);
        if (added) legs.push({ markId: added.id, side: added.side, pending: true });
        else out.problems.push(`${d.division}: "${leg.mark}" is not a known mark.`);
      }
    }
    out.divisions.push({ division: d.division, legs });
  }

  for (const u of data.unmatched || []) {
    out.problems.push(`Could not match "${u}" to a mark.`);
  }
  if (!out.divisions.length) out.problems.push('No course was found on the board.');

  out.suggested = pickDivision(out.divisions, divisionId);
  return out;
}

function sanitiseId(label) {
  const s = String(label || 'NEW').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (s || 'NEW').slice(0, 6);
}

/** Which of the board's divisions is probably ours. */
function pickDivision(divisions, divisionId) {
  if (!divisions.length) return null;
  if (divisions.length === 1) return divisions[0];
  const want = divisionId === 'D1' ? '1' : divisionId === 'D2' ? '2' : null;
  if (want) {
    const hit = divisions.find(d => {
      const m = d.division.match(/(\d)/);
      return m && m[1] === want;
    });
    if (hit) return hit;
  }
  if (divisionId === 'IRC') {
    const hit = divisions.find(d => /irc/i.test(d.division));
    if (hit) return hit;
  }
  return null;
}

/**
 * Apply a confirmed proposal to the course. Adds any new marks first so the
 * legs that reference them resolve, then replaces the leg list wholesale.
 */
export function applyProposal(course, proposal, chosen) {
  const div = chosen || proposal.suggested;
  if (!div) return { ok: false, error: 'Pick which division to load.' };
  for (const nm of proposal.newMarks || []) {
    if (course.markById(nm.id)) continue;
    course.addLocalMark({
      id: nm.id, name: nm.label, lat: nm.pos.lat, lon: nm.pos.lon,
      note: 'Read from the briefing board — verify against the board before starting.',
    });
  }
  course.legs = div.legs.map(l => ({ markId: l.markId, side: l.side }));
  return { ok: true, count: course.legs.length, division: div.division };
}

/** A short human summary of a course, for the confirm step. */
export function describeLegs(course, legs) {
  if (!legs || !legs.length) return 'Start — Finish';
  const parts = legs.map(l => {
    const m = course.markById(l.markId);
    return `${m ? m.id : l.markId}${l.side ? '(' + l.side + ')' : ''}`;
  });
  return ['Start', ...parts, 'Finish'].join(' — ');
}
