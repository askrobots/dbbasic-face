#!/usr/bin/env node
/**
 * Puppet stage server.
 *
 * - Renders TTS to WAV via macOS `say` or `espeak`, extracts a viseme
 *   timeline with Rhubarb Lip Sync, and serves both to the browser stage.
 * - Broadcasts direction cues (speech, actions, movement) to all connected
 *   stages over Server-Sent Events.
 * - Runs "screenplay" scripts: plain lines are spoken, [bracketed] lines are
 *   stage directions, (action) prefixes run concurrently with speech.
 *
 * Zero npm dependencies.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = __dirname;
const CACHE = path.join(ROOT, 'cache');
const PUBLIC = path.join(ROOT, 'public');
const CHARACTERS = path.join(ROOT, 'characters');
const ASSETS = path.join(ROOT, 'assets');
const EXAMPLES = path.join(ROOT, 'examples');
const RHUBARB = findRhubarb();
const PORT = process.env.PORT || 3123;

// Format-agnostic asset resolution: an asset id resolves to the first
// existing file among a known extension set (SVG first, then raster), so
// PNG/JPG/WebP/GIF drop into the same slots as SVG with no code change.
const ASSET_EXTS = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif'];

// music/sfx assets are JSON note patterns (see docs/design/actors-wearables-
// music.md), not images, so they resolve against their own extension set.
const AUDIO_KINDS = ['music', 'sfx'];
const AUDIO_EXTS = ['.json'];

function resolveAsset(kind, id) {
  const exts = AUDIO_KINDS.includes(kind) ? AUDIO_EXTS : ASSET_EXTS;
  for (const ext of exts) {
    const file = path.join(ASSETS, kind, id + ext);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function findRhubarb() {
  if (process.env.RHUBARB_PATH) return process.env.RHUBARB_PATH;
  const toolsDir = path.join(ROOT, 'tools');
  try {
    for (const entry of fs.readdirSync(toolsDir)) {
      const candidate = path.join(toolsDir, entry, 'rhubarb');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* no tools dir yet */ }
  return 'rhubarb'; // hope it's on PATH; probeRhubarb() handles absence
}

fs.mkdirSync(CACHE, { recursive: true });

// ---------------------------------------------------------------- helpers

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function readRaw(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// ------------------------------------------------------------ SSE clients

const clients = new Set();

function broadcast(cue) {
  const msg = `data: ${JSON.stringify(cue)}\n\n`;
  for (const res of clients) res.write(msg);
}

setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000);

// ------------------------------------------------------------- TTS + sync

let rhubarbOk = null; // lazily probed
let lastSlowpx = 0; // Date.now() at the start of the most recent /slowpx request (nav marker for screenshot timing)

async function probeRhubarb() {
  if (rhubarbOk !== null) return rhubarbOk;
  try { await run(RHUBARB, ['--version']); rhubarbOk = true; }
  catch { rhubarbOk = false; console.warn('rhubarb unavailable; falling back to amplitude lip-sync'); }
  return rhubarbOk;
}

// Per-key in-flight render dedup: two concurrent callers for the same cache
// key (e.g. a script re-performed while its render-ahead window is still
// in flight, or /api/say racing that same render-ahead) must not both render
// to the same raw temp path — the second render's ffmpeg step can lose the
// race against the first's cleanup unlink ("ffmpeg failed"). Instead, the
// second caller awaits the first's promise and both read the same result.
const speechInFlight = new Map(); // key -> Promise<void>
const externalAudioInFlight = new Map(); // key -> Promise<void>

/**
 * Render `text` with the given engine and produce {audio, timeline, duration}.
 * Results are cached by content hash in cache/.
 */
async function prepareSpeech({ text, engine = 'say', voice = '', rate = 0 }) {
  engine = engine === 'espeak' ? 'espeak' : 'say';
  const key = sha1([engine, voice, rate, text].join('|'));
  const wav = path.join(CACHE, `${key}.wav`);
  const meta = path.join(CACHE, `${key}.meta.json`);

  if (!fs.existsSync(wav) || !fs.existsSync(meta)) {
    let p = speechInFlight.get(key);
    if (!p) {
      p = renderSpeech(key, wav, meta, { text, engine, voice, rate });
      speechInFlight.set(key, p);
      p.finally(() => {
        if (speechInFlight.get(key) === p) speechInFlight.delete(key);
      });
    }
    await p;
  }

  const { timeline, duration } = JSON.parse(fs.readFileSync(meta, 'utf8'));
  return { audio: `/audio/${key}.wav`, timeline, duration, text };
}

// Does the actual say/espeak -> ffmpeg -> rhubarb render for prepareSpeech.
// Split out so prepareSpeech can dedup concurrent callers on `key` instead
// of each starting its own render into the same raw temp path.
async function renderSpeech(key, wav, meta, { text, engine, voice, rate }) {
  const raw = path.join(CACHE, `${key}.raw.${engine === 'say' ? 'aiff' : 'wav'}`);
  if (engine === 'say') {
    const args = ['-o', raw];
    if (voice) args.push('-v', voice);
    if (rate) args.push('-r', String(rate));
    args.push(text);
    await run('say', args);
  } else {
    const args = ['-w', raw];
    if (voice) args.push('-v', voice);
    if (rate) args.push('-s', String(rate));
    args.push(text);
    await run('espeak', args);
  }
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw,
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
  fs.unlinkSync(raw);

  let timeline = null;
  let duration = 0;
  if (await probeRhubarb()) {
    try {
      const dialog = path.join(CACHE, `${key}.txt`);
      fs.writeFileSync(dialog, text);
      const out = await run(RHUBARB, ['-f', 'json', '--extendedShapes', 'GHX',
        '--dialogFile', dialog, wav]);
      const parsed = JSON.parse(out);
      timeline = parsed.mouthCues;
      duration = parsed.metadata.duration;
      fs.unlinkSync(dialog);
    } catch (e) {
      console.warn('rhubarb failed for this clip:', e.message);
    }
  }
  if (!duration) {
    const probe = await run('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration', '-of', 'csv=p=0', wav]);
    duration = parseFloat(probe) || 0;
  }
  fs.writeFileSync(meta, JSON.stringify({ timeline, duration }));
}

/**
 * Lip-sync audio rendered elsewhere (e.g. an external TTS service):
 * normalize it, run Rhubarb (using `text` as a dialog hint if given),
 * and return the same {audio, timeline, duration} shape as prepareSpeech.
 */
async function prepareExternalAudio(bytes, text = '') {
  const key = sha1('ext|' + text + '|' + crypto.createHash('sha1').update(bytes).digest('hex'));
  const wav = path.join(CACHE, `${key}.wav`);
  const meta = path.join(CACHE, `${key}.meta.json`);

  if (!fs.existsSync(wav) || !fs.existsSync(meta)) {
    let p = externalAudioInFlight.get(key);
    if (!p) {
      p = renderExternalAudio(key, wav, meta, bytes, text);
      externalAudioInFlight.set(key, p);
      p.finally(() => {
        if (externalAudioInFlight.get(key) === p) externalAudioInFlight.delete(key);
      });
    }
    await p;
  }

  const { timeline, duration } = JSON.parse(fs.readFileSync(meta, 'utf8'));
  return { audio: `/audio/${key}.wav`, timeline, duration, text };
}

// Does the actual ffmpeg -> rhubarb render for prepareExternalAudio. Split
// out so prepareExternalAudio can dedup concurrent callers on `key` instead
// of each starting its own render into the same raw temp path.
async function renderExternalAudio(key, wav, meta, bytes, text) {
  const raw = path.join(CACHE, `${key}.raw`);
  fs.writeFileSync(raw, bytes);
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw,
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
  fs.unlinkSync(raw);

  let timeline = null;
  let duration = 0;
  if (await probeRhubarb()) {
    try {
      const args = ['-f', 'json', '--extendedShapes', 'GHX'];
      if (text) {
        const dialog = path.join(CACHE, `${key}.txt`);
        fs.writeFileSync(dialog, text);
        args.push('--dialogFile', dialog);
      }
      const out = await run(RHUBARB, [...args, wav]);
      const parsed = JSON.parse(out);
      timeline = parsed.mouthCues;
      duration = parsed.metadata.duration;
    } catch (e) {
      console.warn('rhubarb failed for external audio:', e.message);
    }
  }
  if (!duration) {
    const probe = await run('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration', '-of', 'csv=p=0', wav]);
    duration = parseFloat(probe) || 0;
  }
  fs.writeFileSync(meta, JSON.stringify({ timeline, duration }));
}

// ---------------------------------------------------------- script runner

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// rough pacing estimates for sequencing; the browser animates the real thing
const ACTION_SECONDS = { wave: 1.6, jump: 0.9, nod: 1.2, shake: 1.2, bow: 1.8, dance: 2.4 };

// Layout presets: macros that clear existing frames and create the named
// ones. Only the frame-id bookkeeping needed while parsing lives here — the
// actual rect math is the client's job (public/stage.js).
const LAYOUT_FRAMES = {
  single: ['main'],
  split: ['left', 'right'],
  stack: ['top', 'bottom'],
  thirds: ['third-l', 'third-c', 'third-r'],
  'pip-tr': ['main', 'pip'], 'pip-tl': ['main', 'pip'],
  'pip-br': ['main', 'pip'], 'pip-bl': ['main', 'pip'],
};

// Tokenize `key:value key:"quoted value"` pairs, e.g. `character:ava bg:desk`.
function parseKV(str) {
  const out = {};
  const re = /([a-z][\w-]*):("([^"]*)"|\S+)/gi;
  let m;
  while ((m = re.exec(str))) out[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[2];
  return out;
}

// left/center|middle/right resolve to stage-percent positions (25/50/75,
// case-insensitive); anything else parses as a literal percent number.
// Used wherever a direction's x might be authored as a word instead of a
// number: [place ... at <pos>], [walk to <pos>], [<id> walk <pos>],
// [<id> move <pos>]. Does NOT apply to [enter/exit] left|right, which mean
// off-stage sides, not on-stage positions.
function parsePosWord(v) {
  const w = String(v == null ? '' : v).toLowerCase();
  if (w === 'left') return 25;
  if (w === 'center' || w === 'middle') return 50;
  if (w === 'right') return 75;
  return parseFloat(v);
}

// Resolves a bare id/name to the frame or actor it refers to: a declared
// frame id or actor id wins as-is; otherwise, if `id` names a character
// who's been framed/placed (tracked in charLocs, see parseScript), resolve
// through that mapping. Falls back to `id` itself (unresolved) so callers
// keep their existing "unknown target" handling for genuinely bad input.
function resolveTarget(id, frameIds, actorIds, charLocs) {
  if (frameIds.has(id) || actorIds.has(id)) return id;
  const loc = charLocs && charLocs.get(id);
  return loc ? loc.id : id;
}

// Speaker-prefix resolution shared by plain "<id>: text" lines and the
// bracket-line tolerance in parseScript: frame id -> actor id -> character
// name (via charLocs). Returns {frame|actor, text} or null if the label
// isn't a known target, in which case the string is left alone by the
// caller (spoken/directed verbatim, prefix and all).
function matchSpeaker(text, frameIds, actorIds, charLocs) {
  const m = text.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
  if (!m) return null;
  if (frameIds.has(m[1])) return { frame: m[1], text: m[2] };
  if (actorIds.has(m[1])) return { actor: m[1], text: m[2] };
  const loc = charLocs && charLocs.get(m[1]);
  if (loc) return loc.kind === 'frame' ? { frame: loc.id, text: m[2] } : { actor: loc.id, text: m[2] };
  return null;
}

/**
 * Parse a screenplay into a cue list.
 *   [wave]                 → action cue
 *   [walk to 70]           → movement (percent of stage width; also accepts
 *                             left|center|middle|right as 25/50/75)
 *   [look left|right|front], [emote happy], [wait 1.5]
 *   [engine espeak], [voice Samantha], [rate 180]  → speech settings
 *   [layout split]         → frame layout preset
 *   [frame left character:ava bg:desk view:face]   → create/update a frame
 *   [frame right clear]   → remove a frame
 *   [scene desk]           → set the active frame's background
 *   [show image:chart fit:contain]  → content tile in the active frame
 *   [lower-third "Ava Reyes" "Host"] → overlay, auto-dismissed after a
 *                             6000ms hold by default; add a trailing
 *                             `hold:<ms>` to override (`hold:0` persists —
 *                             no auto-dismiss — matching the old behavior)
 *   [lower-third clear]    → remove the current lower-third early
 *   [clear]                 → wipe every placed actor (and its worn props),
 *                             every frame's content tile, and every overlay
 *                             across the whole stage — the same cleanup a
 *                             new script runs automatically on script-start.
 *                             Music, captions on/off, backgrounds, and frame
 *                             layout are left alone.
 *   [captions on|off]      → toggle the caption bar (default on)
 *   [iris out|in 900], [fade out|in 900]  → fullscreen transition
 *                             (ms optional, default 700)
 *   left: Good evening.    → speak cue targeting frame "left" (id must be
 *                             a frame declared earlier in the script); once
 *                             a character has been framed/placed, its NAME
 *                             works the same way — `rex: Woof!` resolves to
 *                             whichever frame/actor rex currently occupies
 *                             (resolution order: frame id, actor id, name)
 *   [left: Good evening.]  → same as the line above, tolerated: a bracketed
 *                             line whose inner text is itself a speaker
 *                             prefix is unwrapped to a spoken line rather
 *                             than treated as an unknown direction
 *   [left wave]            → direction targeting frame "left"; a placed/
 *                             framed character's name also routes here,
 *                             e.g. [rex sit] once rex occupies a frame/actor
 *   (wave) Hello!          → action fired concurrently with the line
 *   Hello!                 → speech
 *
 *   [place hoop at 70 scale:0.5]        → place a prop/character actor
 *                             ("at" required — a percent number or
 *                             left|center|middle|right (25/50/75); "id:"
 *                             defaults to the name, "scale:" defaults 1 for
 *                             characters/0.4 for props, bare "behind" flag
 *                             draws it behind the frame's primary character)
 *   [place rex at 15 scale:0.6 id:sidekick]  → `what` names a folder in
 *                             characters/ → a full rig; otherwise it
 *                             resolves as assets/props/<what>
 *   [remove sidekick]       → destroy a placed actor
 *   [<id> move 40], [<id> scale 0.8], [<id> spin], [<id> bounce] → prop
 *                             actor directions (glide/resize/spin/hop)
 *   sidekick: Woof!          → speak cue targeting an actor id (same
 *                             resolution order as frame ids: frame first,
 *                             then actor)
 *   [sidekick leap]          → direction on a character actor — the full
 *                             direction set applies (walk/emote/actions/
 *                             speak), same grammar as a frame id
 *   [wear right tophat], [wear right tophat scale:1.2 anchor:head],
 *   [unwear right]           → pin/remove a prop asset at a character's
 *                             named anchor (`target` is a frame id — its
 *                             primary character — an actor id, or (once
 *                             framed/placed) a character name; anchor
 *                             defaults to "head")
 *   [music circus]           → cross-fade to assets/music/circus.json
 *                             (a looping JSON note pattern), stage-global
 *   [music off]              → fade out and stop the current music
 *   [sfx tada]                → one-shot assets/sfx/tada.json, not looped,
 *                             not ducked
 */
function parseScript(src) {
  const cues = [];
  const frameIds = new Set(['main']); // tracks declared frame ids as we go
  const actorIds = new Set(); // tracks ids declared by [place ...] as we go
  // character name -> {kind:'frame'|'actor', id} it currently occupies, so
  // writers can address characters by name once they've been framed/placed
  // (`[rex sit]`, `rex: Woof!`, `[wear bo tophat]`); later assignments
  // override earlier ones. Populated by directionCue's frame/place handling.
  const charLocs = new Map();
  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (/^(\[[^\]]+\]\s*)+$/.test(line)) {
      for (const m of line.matchAll(/\[([^\]]+)\]/g)) {
        const inner = m[1];
        // Tolerance: `[left: some words]` / `[<name>: words]` is a spoken
        // line wearing brackets by mistake (common in LLM-authored
        // screenplays) — unwrap it instead of treating it as an unknown
        // direction, but only when the label actually resolves.
        const sp = matchSpeaker(inner, frameIds, actorIds, charLocs);
        if (sp) {
          const cue = { type: 'speak', text: sp.text, concurrent: null, source: line };
          if (sp.frame) cue.frame = sp.frame;
          if (sp.actor) cue.actor = sp.actor;
          cues.push(cue);
        } else {
          cues.push(directionCue(inner, line, frameIds, actorIds, charLocs));
        }
      }
      continue;
    }

    let text = line;
    let frame = null;
    let actor = null;
    const sp = matchSpeaker(text, frameIds, actorIds, charLocs);
    if (sp) { frame = sp.frame || null; actor = sp.actor || null; text = sp.text; }

    let concurrent = null;
    const inline = text.match(/^\(([^)]+)\)\s*(.*)$/);
    if (inline) {
      concurrent = directionCue(inline[1], line, frameIds, actorIds, charLocs);
      text = inline[2];
      if (frame) concurrent.frame = frame;
      if (actor) concurrent.actor = actor;
    }
    const cue = { type: 'speak', text, concurrent, source: line };
    if (frame) cue.frame = frame;
    if (actor) cue.actor = actor;
    cues.push(cue);
  }
  return cues;
}

function directionCue(body, source, frameIds, actorIds, charLocs) {
  frameIds = frameIds || new Set(['main']);
  actorIds = actorIds || new Set();
  charLocs = charLocs || new Map();
  const parts = body.trim().split(/\s+/);
  const head = parts[0].toLowerCase();

  if (head === 'layout') {
    const preset = (parts[1] || 'single').toLowerCase();
    const ids = LAYOUT_FRAMES[preset] || ['main'];
    frameIds.clear();
    for (const id of ids) frameIds.add(id);
    return { type: 'layout', preset, source };
  }

  if (head === 'frame') {
    const id = parts[1];
    const restStr = parts.slice(2).join(' ');
    if (/^clear\b/i.test(restStr)) {
      frameIds.delete(id);
      return { type: 'frame-clear', id, source };
    }
    const kv = parseKV(restStr);
    const cue = { type: 'frame', id, source };
    if (kv.slot) cue.slot = kv.slot;
    if (kv.bg) cue.bg = kv.bg;
    if (kv.character) cue.character = kv.character;
    if (kv.view) cue.view = kv.view;
    if (kv.facing !== undefined) cue.facing = parseInt(kv.facing, 10);
    if (kv.rect) cue.rect = kv.rect.split(',').map(Number);
    frameIds.add(id);
    if (kv.character) charLocs.set(kv.character, { kind: 'frame', id });
    return cue;
  }

  if (head === 'scene') return { type: 'scene', bg: parts.slice(1).join(' '), source };

  if (head === 'show') {
    const kv = parseKV(parts.slice(1).join(' '));
    let kind = 'text', value = '';
    for (const k of ['text', 'image', 'video']) {
      if (kv[k] !== undefined) { kind = k; value = kv[k]; break; }
    }
    const cue = { type: 'content', kind, value, source };
    if (kv.fit) cue.fit = kv.fit;
    return cue;
  }

  if (head === 'lower-third') {
    // stable id so a new lower-third replaces the current one instead of
    // stacking; `[lower-third clear]` removes it.
    if ((parts[1] || '').toLowerCase() === 'clear' && !body.includes('"')) {
      return { type: 'overlay-clear', id: 'lower-third', source };
    }
    const strs = [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    const cue = {
      type: 'overlay', template: 'lower-third', id: 'lower-third',
      slots: { title: strs[0] || '', subtitle: strs[1] || '' }, source,
    };
    // Optional trailing `hold:<ms>` key: default 6000 (auto-dismiss after
    // 6s) when omitted; `hold:0` means persist (omit hold entirely, same as
    // the old un-timed behavior); any other value is that hold in ms.
    const holdMatch = body.match(/\bhold:(\d+)\b/i);
    const holdMs = holdMatch ? parseInt(holdMatch[1], 10) : 6000;
    if (holdMs > 0) cue.hold = holdMs;
    return cue;
  }

  if (head === 'walk' || head === 'enter' || head === 'exit') {
    // [walk to 70] [walk to center] [enter from left] [exit right]
    const arg = parts[parts.length - 1].toLowerCase();
    // walk's left/right are on-stage position words (25/75); enter/exit's
    // left/right stay off-stage sides — handled separately below.
    let x = head === 'walk' ? parsePosWord(arg) : parseFloat(arg);
    if (head === 'enter') x = 50;
    else if (head === 'exit' && isNaN(x)) x = arg === 'left' ? -15 : 115;
    const from = parts.includes('from') ? (parts[parts.indexOf('from') + 1] || '') : null;
    return { type: 'walk', x, from, jump: head === 'enter' ? from : null, source };
  }
  if (head === 'wait') return { type: 'wait', seconds: parseFloat(parts[1]) || 1, source };
  if (head === 'view' || head === 'zoom') {
    return { type: 'view', mode: (parts[1] || 'body').toLowerCase(), source };
  }
  if (head === 'look') return { type: 'look', dir: parts[1] || 'front', source };
  if (head === 'emote') return { type: 'action', name: parts[1] || 'neutral', source };
  if (head === 'engine' || head === 'voice' || head === 'rate') {
    return { type: 'setting', key: head, value: parts.slice(1).join(' '), source };
  }
  if (head === 'captions') {
    const arg = (parts[1] || 'on').toLowerCase();
    return { type: 'captions', on: arg !== 'off', source };
  }
  if (head === 'iris' || head === 'fade') {
    const ms = parseInt(parts[2], 10);
    return { type: 'transition', name: head, dir: (parts[1] || 'out').toLowerCase(), ms: isNaN(ms) ? 700 : ms, source };
  }

  if (head === 'place') {
    // [place <what> at <x> [id:<id>] [scale:<n>] [behind]] — <x> accepts a
    // percent number or left|center|middle|right (25/50/75).
    const rest = parts.slice(1);
    const what = rest[0];
    const atIdx = rest.indexOf('at');
    const x = atIdx >= 0 ? parsePosWord(rest[atIdx + 1]) : NaN;
    const restStr = parts.slice(1).join(' ');
    const kv = parseKV(restStr);
    const id = kv.id || what;
    const cue = { type: 'place', id, what, x, source };
    if (kv.scale !== undefined) cue.scale = parseFloat(kv.scale);
    if (/\bbehind\b/.test(restStr)) cue.behind = true;
    actorIds.add(id);
    // `what` names a character iff it's a folder in characters/ — track
    // where it now lives so later `[<what> ...]`/`what: text` addresses it.
    if (fs.existsSync(path.join(CHARACTERS, what))) charLocs.set(what, { kind: 'actor', id });
    return cue;
  }

  if (head === 'remove') {
    const id = parts[1];
    actorIds.delete(id);
    return { type: 'remove', id, source };
  }

  if (head === 'wear') {
    // [wear <target> <prop> [scale:<n>] [anchor:<name>]] — target resolves
    // frame id -> actor id -> character name (see resolveTarget).
    const target = resolveTarget(parts[1], frameIds, actorIds, charLocs);
    const prop = parts[2];
    const kv = parseKV(parts.slice(3).join(' '));
    const cue = { type: 'wear', target, prop, source };
    if (kv.scale !== undefined) cue.scale = parseFloat(kv.scale);
    if (kv.anchor !== undefined) cue.anchor = kv.anchor;
    return cue;
  }

  if (head === 'unwear') {
    const target = resolveTarget(parts[1], frameIds, actorIds, charLocs);
    const cue = { type: 'unwear', target, source };
    if (parts[2]) cue.anchor = parts[2];
    return cue;
  }

  if (head === 'music') {
    const arg = (parts[1] || '').toLowerCase();
    if (arg === 'off') return { type: 'music', off: true, source };
    return { type: 'music', id: parts[1], source };
  }

  if (head === 'sfx') return { type: 'sfx', id: parts[1], source };

  // Prop-actor directions — only meaningful when the head token that routed
  // here was an actor id (see the actorIds fallback below), e.g.
  // [hoop1 move 40] recurses into directionCue("move 40", ...).
  if (head === 'move') return { type: 'move', x: parsePosWord(parts[1]), source };
  if (head === 'scale') return { type: 'scale', value: parseFloat(parts[1]), source };
  if (head === 'spin') return { type: 'spin', source };
  if (head === 'bounce') return { type: 'bounce', source };

  // [<id> <direction...>] — first token is a known frame id: apply the rest
  // of the direction to that frame.
  if (frameIds.has(head) && parts.length > 1) {
    const sub = directionCue(parts.slice(1).join(' '), source, frameIds, actorIds, charLocs);
    sub.frame = head;
    return sub;
  }

  // Same, for a placed actor id (checked after frame ids, per spec).
  if (actorIds.has(head) && parts.length > 1) {
    const sub = directionCue(parts.slice(1).join(' '), source, frameIds, actorIds, charLocs);
    sub.actor = head;
    return sub;
  }

  // Same, for a character NAME that's been framed/placed (checked after
  // frame ids and actor ids, per spec) — e.g. [rex sit] once rex occupies a
  // frame or actor slot; resolves to whichever one it currently occupies.
  {
    const loc = charLocs.get(head);
    if (loc && parts.length > 1) {
      const sub = directionCue(parts.slice(1).join(' '), source, frameIds, actorIds, charLocs);
      if (loc.kind === 'frame') sub.frame = loc.id; else sub.actor = loc.id;
      return sub;
    }
  }

  // [clear] — wipe placed actors/worn props/content tiles/overlays across
  // every frame, on demand mid-script (same cleanup `script-start` runs
  // automatically). Music, captions on/off, backgrounds, and frame layout
  // are untouched.
  if (head === 'clear') return { type: 'clear', source };

  return { type: 'action', name: head, source };
}

let scriptToken = 0;

// Per-character declared voice, e.g. characters/ava/manifest.json's
// `"voice": {"engine":"say","voice":"Samantha"}`. Cached by character name
// so screenplays with many lines don't re-read manifests per cue.
const characterVoiceCache = {};
function characterVoice(name) {
  if (!name) return null;
  if (Object.prototype.hasOwnProperty.call(characterVoiceCache, name)) return characterVoiceCache[name];
  let voice = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(CHARACTERS, name, 'manifest.json'), 'utf8'));
    if (manifest && manifest.voice) voice = manifest.voice;
  } catch { /* missing/unreadable manifest; fall back to default voice */ }
  characterVoiceCache[name] = voice;
  return voice;
}

// Single ordered pass over a parsed cue list that replays the same
// settings/frameChar/override-flag state the (formerly inline) speak handler
// used, and attaches the fully-resolved TTS params to every speak cue as
// `cue.speech`. Pulling this out lets runScript render speech ahead of the
// playback loop instead of only when a line is about to play.
function resolveSpeech(cues, mainCharacter) {
  const settings = { engine: 'say', voice: '', rate: 0 };
  let engineOverridden = false;
  let voiceOverridden = false;
  // frame id -> character name, so each spoken line can resolve the voice of
  // whoever is actually in that frame. Seeded with the client's notion of
  // who's in the main frame, so solo screenplays pick up that character's
  // declared voice too.
  const frameChar = {};
  if (mainCharacter) frameChar.main = mainCharacter;
  // actor id -> character name, for actor-targeted speak cues (mirrors
  // frameChar but seeded from [place] cues instead of [frame]/[character]).
  const actorChar = {};

  for (const cue of cues) {
    if (cue.type === 'setting') {
      settings[cue.key] = cue.value;
      if (cue.key === 'engine') engineOverridden = true;
      if (cue.key === 'voice') voiceOverridden = true;
      continue;
    }
    if (cue.type === 'frame' && cue.character) frameChar[cue.id] = cue.character;
    if (cue.type === 'character') frameChar[cue.frame || 'main'] = cue.name;
    if (cue.type === 'place') {
      // `what` names a character iff it's a folder in characters/; a prop
      // actor placed over a stale id clears any earlier character mapping.
      if (fs.existsSync(path.join(CHARACTERS, cue.what))) actorChar[cue.id] = cue.what;
      else delete actorChar[cue.id];
    }
    if (cue.type === 'remove') delete actorChar[cue.id];

    if (cue.type === 'speak') {
      // Resolution: an explicit [engine]/[voice] direction always wins;
      // otherwise use the declared voice of the character in this line's
      // actor (if actor-targeted) or frame; otherwise fall back to the
      // (default) settings.
      const charName = cue.actor ? actorChar[cue.actor] : frameChar[cue.frame || 'main'];
      const cv = characterVoice(charName);
      const engine = engineOverridden ? settings.engine : (cv && cv.engine) || settings.engine;
      const voice = voiceOverridden ? settings.voice : (cv && cv.voice !== undefined ? cv.voice : settings.voice);
      cue.speech = { text: cue.text, engine, voice, rate: settings.rate };
    }
  }
}

const RENDER_WINDOW = 4;

async function runScript(src, mainCharacter) {
  const token = ++scriptToken;
  const cues = parseScript(src);
  resolveSpeech(cues, mainCharacter);
  const speakCues = cues.filter((c) => c.type === 'speak');

  // Bounded render-ahead: kick off prepareSpeech for the k-th speak cue at
  // most once, and stash the promise on the cue itself. Calling this
  // repeatedly (e.g. re-priming a window that's already full) is a no-op.
  function ensureRender(k) {
    if (k < 0 || k >= speakCues.length) return;
    const c = speakCues[k];
    if (!c._renderP) {
      c._renderP = prepareSpeech(c.speech);
      c._renderP.catch(() => {}); // avoid unhandled-rejection noise; real errors surface at the await below
    }
  }

  for (let k = 0; k < RENDER_WINDOW; k++) ensureRender(k);
  let speakIndex = 0;

  if (speakCues.length > 0) {
    try {
      await speakCues[0]._renderP;
    } catch (e) {
      // ignore here; the playback loop's per-line error handling will surface
      // this once it reaches line 1
    }
    if (token !== scriptToken) return; // replaced while pre-rendering; don't start
  }

  broadcast({ type: 'script-start', lines: cues.map((c) => c.source) });

  for (let i = 0; i < cues.length; i++) {
    if (token !== scriptToken) break; // stopped or replaced
    const cue = cues[i];
    broadcast({ type: 'script-line', index: i });

    if (cue.type === 'setting' || cue.type === 'wait') {
      if (cue.type === 'wait') await sleep(cue.seconds * 1000);
      continue;
    }

    if (cue.type === 'speak') {
      const k = speakIndex++;
      ensureRender(k); // in case it wasn't primed (e.g. window > remaining lines)
      let prepared;
      try {
        prepared = await cue._renderP;
      } catch (e) {
        broadcast({ type: 'error', message: e.message });
        ensureRender(k + RENDER_WINDOW);
        continue;
      }
      if (token !== scriptToken) break;
      if (cue.concurrent) broadcast(cue.concurrent);
      const speakCue = { type: 'speak', ...prepared };
      if (cue.frame) speakCue.frame = cue.frame;
      if (cue.actor) speakCue.actor = cue.actor;
      broadcast(speakCue);
      await sleep(prepared.duration * 1000 + 300);
      ensureRender(k + RENDER_WINDOW);
      continue;
    }

    broadcast(cue);
    if (cue.type === 'action') await sleep((ACTION_SECONDS[cue.name] || 1) * 1000);
    else if (cue.type === 'walk') await sleep(1200);
    else if (cue.type === 'transition') await sleep(cue.ms + 100);
    else await sleep(400);
  }

  if (token === scriptToken) broadcast({ type: 'script-end' });
}

// ----------------------------------------------------------------- voices

async function listVoices(engine) {
  if (engine === 'espeak') {
    const out = await run('espeak', ['--voices']);
    return out.split('\n').slice(1).map((l) => l.trim().split(/\s+/)[3]).filter(Boolean);
  }
  const out = await run('say', ['-v', '?']);
  return out.split('\n')
    .map((l) => l.match(/^(.+?)\s{2,}([a-z]{2}[_-]\w+)/))
    .filter((m) => m && m[2].startsWith('en'))
    .map((m) => m[1].trim());
}

// ------------------------------------------------------ conversation mode
//
// CONVERSATION MODE: push-to-talk speech -> OpenAI transcription -> an
// OpenAI chat completion replying in character -> spoken back through the
// existing prepareSpeech/broadcast pipeline. Key loading mirrors the
// integrations/dbbasic/puppet-stage director.py convention (OPENAI_API_KEY
// env, else an OPENAI_KEY_FILE .env-style file) so both surfaces agree on
// how a deployment supplies the key. The key lives only in this
// module-level variable — never logged, never echoed back in a response.

let openaiKey = '';
(function loadOpenAIKey() {
  const env = (process.env.OPENAI_API_KEY || '').trim();
  if (env) { openaiKey = env; return; }
  const file = (process.env.OPENAI_KEY_FILE || '').trim();
  if (!file) return;
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split('\n')) {
      const l = line.trim();
      if (l.startsWith('OPENAI_API_KEY=')) {
        openaiKey = l.slice('OPENAI_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
        break;
      }
    }
  } catch { /* missing/unreadable key file; converse endpoints report not-configured */ }
})();

const NO_KEY_ERROR = 'no OpenAI key configured (set OPENAI_API_KEY or OPENAI_KEY_FILE)';
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';
const CONVERSE_MODEL = process.env.CONVERSE_MODEL || 'gpt-5.4-mini';

// Content-Type -> filename extension, so the multipart upload's filename
// matches the container the browser actually recorded (webm/ogg/mp4/wav).
function audioExtFromContentType(ct) {
  ct = (ct || '').toLowerCase();
  if (ct.includes('ogg')) return 'ogg';
  if (ct.includes('mp4') || ct.includes('m4a') || ct.includes('aac')) return 'mp4';
  if (ct.includes('wav')) return 'wav';
  return 'webm';
}

// Zero-dependency multipart/form-data POST to OpenAI's transcription
// endpoint: two fields (model, file) built by hand via Buffer.concat.
async function openaiTranscribe(bytes, contentType) {
  if (!openaiKey) throw new Error(NO_KEY_ERROR);
  const boundary = `----puppetstage${crypto.randomBytes(16).toString('hex')}`;
  const ext = audioExtFromContentType(contentType);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${TRANSCRIBE_MODEL}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\n` +
    `Content-Type: ${contentType || 'application/octet-stream'}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, bytes, tail]);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let resp, text;
  try {
    resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
      signal: controller.signal,
    });
    text = await resp.text();
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${text.slice(0, 300)}`);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('unexpected OpenAI response (transcribe)'); }
  return parsed.text || '';
}

// Zero-dependency chat completion call for the in-character reply.
async function openaiChat(messages) {
  if (!openaiKey) throw new Error(NO_KEY_ERROR);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let resp, text;
  try {
    resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({ model: CONVERSE_MODEL, messages, temperature: 0.8 }),
      signal: controller.signal,
    });
    text = await resp.text();
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${text.slice(0, 300)}`);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('unexpected OpenAI response (chat)'); }
  const content = parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
  if (!content) throw new Error('unexpected OpenAI response shape (chat)');
  return content.trim();
}

// Per-session rolling chat history: session id -> {messages:[{role,content}],
// lastActive}. Capped at the last 20 messages; idle sessions (30 min) are
// pruned opportunistically whenever /api/converse is next called.
const CONVERSE_HISTORY_CAP = 20;
const CONVERSE_IDLE_MS = 30 * 60 * 1000;
const conversations = new Map();

function conversationFor(id) {
  const now = Date.now();
  for (const [k, v] of conversations) {
    if (now - v.lastActive > CONVERSE_IDLE_MS) conversations.delete(k);
  }
  let s = conversations.get(id);
  if (!s) { s = { messages: [], lastActive: now }; conversations.set(id, s); }
  s.lastActive = now;
  return s;
}

function pushCapped(list, entry) {
  list.push(entry);
  if (list.length > CONVERSE_HISTORY_CAP) list.splice(0, list.length - CONVERSE_HISTORY_CAP);
}

// Builds the system prompt for a character: manifest.persona if the
// manifest declares one (another agent is adding that field in parallel —
// this only ever READS it), else a generic fallback. Also returns the
// character's action names so the reply can be parsed against them.
function buildConverseContext(character) {
  let persona = null;
  let actionNames = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(CHARACTERS, character, 'manifest.json'), 'utf8'));
    if (manifest && manifest.persona) persona = manifest.persona;
    actionNames = Object.keys((manifest && manifest.actions) || {});
  } catch { /* missing/unreadable manifest; fall back below */ }
  const displayName = character ? character.charAt(0).toUpperCase() + character.slice(1) : 'the puppet';
  const base = persona || `You are ${displayName}, a puppet character on a small stage.`;
  const actionsList = actionNames.length ? actionNames.join(', ') : 'none';
  const prompt = `${base}\n` +
    'You are a live animated puppet on a real stage, and you have a body: you can ' +
    `physically perform these actions right now: ${actionsList}. ` +
    'To perform one, write its name in parentheses inline with your words, e.g. "(nod) Absolutely." ' +
    'Use one when it fits what you are saying — agree with a (nod), refuse with a (shake), ' +
    'delight with a (happy). If someone asks whether you can do something on that list, ' +
    'say yes and DO it in the same reply. At most two actions per reply; only names from ' +
    'the list; nothing else in parentheses.\n' +
    'Reply in character, conversationally, 1-3 short sentences (spoken aloud). No emoji, no markdown.';
  return { prompt, actionNames };
}

// Extracts (action) tokens that match the character's known action names out
// of a reply, in order, and strips them (and the whitespace they leave
// behind) from the spoken text. A parenthetical that ISN'T a known action
// name is left in place rather than silently eaten — the persona prompt
// asks the model not to use parens for anything else, but a stray one
// shouldn't corrupt the spoken line.
function extractActions(text, actionNames) {
  const known = new Set(actionNames);
  const actions = [];
  const stripped = text.replace(/\(([a-zA-Z][\w-]*)\)/g, (whole, name) => {
    if (known.has(name)) { actions.push(name); return ' '; }
    return whole;
  });
  return { text: stripped.replace(/\s+/g, ' ').trim(), actions };
}

// ----------------------------------------------------------------- static

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.wav': 'audio/wav',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ----------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (p === '/api/say' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.text) return json(res, 400, { error: 'text required' });
      const prepared = await prepareSpeech(body);
      const cue = { type: 'speak', ...prepared };
      if (body.frame) cue.frame = body.frame;
      if (body.actor) cue.actor = body.actor;
      broadcast(cue);
      return json(res, 200, prepared);
    }

    // external-TTS entry point: POST raw audio bytes (any ffmpeg-readable
    // format), optional ?text= transcript improves lip-sync accuracy
    if (p === '/api/speak-audio' && req.method === 'POST') {
      const bytes = await readRaw(req);
      if (!bytes.length) return json(res, 400, { error: 'audio body required' });
      const prepared = await prepareExternalAudio(bytes, url.searchParams.get('text') || '');
      broadcast({ type: 'speak', ...prepared });
      return json(res, 200, prepared);
    }

    // CONVERSATION MODE: readiness probe — the UI hides the Converse panel
    // when this reports not-ready (no key configured).
    if (p === '/api/converse' && req.method === 'GET') {
      return json(res, 200, { ready: !!openaiKey });
    }

    // raw audio bytes body (webm/ogg/mp4/wav — whatever the browser's
    // MediaRecorder produced; Content-Type says which), forwarded to
    // OpenAI's transcription endpoint.
    if (p === '/api/transcribe' && req.method === 'POST') {
      if (!openaiKey) return json(res, 400, { error: NO_KEY_ERROR });
      const bytes = await readRaw(req);
      if (!bytes.length) return json(res, 400, { error: 'audio body required' });
      try {
        const text = await openaiTranscribe(bytes, req.headers['content-type']);
        return json(res, 200, { text });
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }

    // {text, character, session, frame?} -> an in-character OpenAI reply,
    // spoken on stage. Broadcasts (in order) a user-said caption cue, an
    // optional concurrent action cue (the reply's first inline action, like
    // a screenplay's (action) prefix), the speak cue itself, then any
    // further inline actions as trailing action cues.
    if (p === '/api/converse' && req.method === 'POST') {
      if (!openaiKey) return json(res, 400, { error: NO_KEY_ERROR });
      const body = await readBody(req);
      const userText = (body.text || '').trim();
      const character = body.character;
      if (!userText) return json(res, 400, { error: 'text required' });
      if (!character) return json(res, 400, { error: 'character required' });

      const session = conversationFor(body.session || 'default');
      const { prompt, actionNames } = buildConverseContext(character);
      pushCapped(session.messages, { role: 'user', content: userText });

      let reply;
      try {
        reply = await openaiChat([{ role: 'system', content: prompt }, ...session.messages]);
      } catch (e) {
        session.messages.pop(); // don't keep a user turn that never got a reply
        return json(res, 502, { error: e.message });
      }
      pushCapped(session.messages, { role: 'assistant', content: reply });

      const { text: spokenText, actions } = extractActions(reply, actionNames);

      broadcast({ type: 'user-said', text: userText });
      if (actions[0]) {
        const actionCue = { type: 'action', name: actions[0] };
        if (body.frame) actionCue.frame = body.frame;
        broadcast(actionCue);
      }

      let prepared;
      try {
        const voice = characterVoice(character) || {};
        prepared = await prepareSpeech({ text: spokenText || reply, engine: voice.engine, voice: voice.voice, rate: voice.rate });
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
      const speakCue = { type: 'speak', ...prepared };
      if (body.frame) speakCue.frame = body.frame;
      broadcast(speakCue);

      for (const name of actions.slice(1)) {
        const cue = { type: 'action', name };
        if (body.frame) cue.frame = body.frame;
        broadcast(cue);
      }

      return json(res, 200, { reply: spokenText, actions, performed: true });
    }

    if (p === '/api/cue' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.type) return json(res, 400, { error: 'type required' });
      broadcast(body);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/script' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.script) return json(res, 400, { error: 'script required' });
      runScript(body.script, body.mainCharacter); // runs in background
      return json(res, 200, { ok: true });
    }

    if (p === '/api/script/stop' && req.method === 'POST') {
      scriptToken++;
      broadcast({ type: 'script-end' });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/voices') {
      return json(res, 200, { voices: await listVoices(url.searchParams.get('engine')) });
    }

    if (p === '/api/characters') {
      const names = fs.readdirSync(CHARACTERS, { withFileTypes: true })
        .filter((d) => d.isDirectory()).map((d) => d.name);
      return json(res, 200, { characters: names });
    }

    // GET /api/examples → basenames (no .txt) of examples/*.txt, sorted.
    if (p === '/api/examples') {
      let names = [];
      try {
        names = fs.readdirSync(EXAMPLES)
          .filter((f) => f.endsWith('.txt'))
          .map((f) => f.slice(0, -'.txt'.length))
          .sort();
      } catch { /* no examples dir yet */ }
      return json(res, 200, { examples: names });
    }

    // GET /api/examples/<name> → {name, script} of examples/<name>.txt.
    if (p.startsWith('/api/examples/')) {
      const rel = path.normalize(p.slice('/api/examples/'.length));
      if (rel.startsWith('..')) { res.writeHead(403); return res.end(); }
      const file = path.join(EXAMPLES, rel + '.txt');
      if (!fs.existsSync(file)) return json(res, 404, { error: 'example not found' });
      return json(res, 200, { name: rel, script: fs.readFileSync(file, 'utf8') });
    }

    // GET /api/assets → {backgrounds, props, overlays, music, sfx}: ids
    // (filenames minus extension) available in assets/<kind>/, deduped
    // across the relevant extension set (svg/raster for most kinds, .json
    // for the audio kinds).
    if (p === '/api/assets') {
      const listKind = (kind) => {
        let files = [];
        try { files = fs.readdirSync(path.join(ASSETS, kind)); } catch { return []; }
        const exts = AUDIO_KINDS.includes(kind) ? AUDIO_EXTS : ASSET_EXTS;
        const ids = new Set();
        for (const f of files) {
          const ext = path.extname(f);
          if (exts.includes(ext)) ids.add(f.slice(0, -ext.length));
        }
        return [...ids].sort();
      };
      return json(res, 200, {
        backgrounds: listKind('backgrounds'),
        props: listKind('props'),
        overlays: listKind('overlays'),
        music: listKind('music'),
        sfx: listKind('sfx'),
      });
    }

    // 1x1 gif served after a delay — lets headless screenshots wait for async boot
    if (p === '/slowpx') {
      lastSlowpx = Date.now(); // marks navigation: the page requests this immediately on load
      const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'image/gif' }); res.end(gif); },
        parseInt(url.searchParams.get('d'), 10) || 2500);
      return;
    }

    // GET /api/last-shot → {t}: Date.now() (server clock) at the start of the
    // most recent /slowpx request, i.e. the navigation timestamp of the most
    // recent headless screenshot page load. Used by the screenshot harness to
    // anchor action cues to actual page navigation instead of a fixed sleep
    // after spawning the browser process (browser startup jitter otherwise
    // made cue timing nondeterministic). 0 if no /slowpx request has landed yet.
    if (p === '/api/last-shot') {
      return json(res, 200, { t: lastSlowpx || 0 });
    }

    // GET /api/asset/<kind>/<id> → the resolved file (first existing
    // extension among svg/png/jpg/jpeg/webp/gif), so the client can learn
    // which format exists without guessing.
    if (p.startsWith('/api/asset/')) {
      const [kind, id] = p.slice('/api/asset/'.length).split('/');
      const file = kind && id ? resolveAsset(kind, id) : null;
      if (!file) return json(res, 404, { error: 'asset not found' });
      return serveFile(res, file);
    }

    // static routes
    if (p.startsWith('/audio/')) return serveFile(res, path.join(CACHE, path.basename(p)));
    if (p.startsWith('/characters/')) {
      const rel = path.normalize(p.slice('/characters/'.length));
      if (rel.startsWith('..')) { res.writeHead(403); return res.end(); }
      return serveFile(res, path.join(CHARACTERS, rel));
    }
    if (p.startsWith('/assets/')) {
      const rel = path.normalize(p.slice('/assets/'.length));
      if (rel.startsWith('..')) { res.writeHead(403); return res.end(); }
      return serveFile(res, path.join(ASSETS, rel));
    }
    const file = p === '/' ? 'index.html' : path.normalize(p).replace(/^\/+/, '');
    if (file.startsWith('..')) { res.writeHead(403); return res.end(); }
    return serveFile(res, path.join(PUBLIC, file));
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Puppet stage: http://localhost:${PORT}`);
});
