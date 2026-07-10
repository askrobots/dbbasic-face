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
const RHUBARB = findRhubarb();
const PORT = process.env.PORT || 3123;

// Format-agnostic asset resolution: an asset id resolves to the first
// existing file among a known extension set (SVG first, then raster), so
// PNG/JPG/WebP/GIF drop into the same slots as SVG with no code change.
const ASSET_EXTS = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif'];

function resolveAsset(kind, id) {
  for (const ext of ASSET_EXTS) {
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

async function probeRhubarb() {
  if (rhubarbOk !== null) return rhubarbOk;
  try { await run(RHUBARB, ['--version']); rhubarbOk = true; }
  catch { rhubarbOk = false; console.warn('rhubarb unavailable; falling back to amplitude lip-sync'); }
  return rhubarbOk;
}

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

  const { timeline, duration } = JSON.parse(fs.readFileSync(meta, 'utf8'));
  return { audio: `/audio/${key}.wav`, timeline, duration, text };
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

  const { timeline, duration } = JSON.parse(fs.readFileSync(meta, 'utf8'));
  return { audio: `/audio/${key}.wav`, timeline, duration, text };
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

/**
 * Parse a screenplay into a cue list.
 *   [wave]                 → action cue
 *   [walk to 70]           → movement (percent of stage width)
 *   [look left|right|front], [emote happy], [wait 1.5]
 *   [engine espeak], [voice Samantha], [rate 180]  → speech settings
 *   [layout split]         → frame layout preset
 *   [frame left character:ava bg:desk view:face]   → create/update a frame
 *   [frame right clear]   → remove a frame
 *   [scene desk]           → set the active frame's background
 *   [show image:chart fit:contain]  → content tile in the active frame
 *   [lower-third "Ava Reyes" "Host"] → overlay
 *   [captions on|off]      → toggle the caption bar (default on)
 *   [iris out|in 900], [fade out|in 900]  → fullscreen transition
 *                             (ms optional, default 700)
 *   left: Good evening.    → speak cue targeting frame "left" (id must be
 *                             a frame declared earlier in the script)
 *   [left wave]            → direction targeting frame "left"
 *   (wave) Hello!          → action fired concurrently with the line
 *   Hello!                 → speech
 */
function parseScript(src) {
  const cues = [];
  const frameIds = new Set(['main']); // tracks declared frame ids as we go
  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (/^(\[[^\]]+\]\s*)+$/.test(line)) {
      for (const m of line.matchAll(/\[([^\]]+)\]/g)) cues.push(directionCue(m[1], line, frameIds));
      continue;
    }

    let text = line;
    let frame = null;
    const speaker = text.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (speaker && frameIds.has(speaker[1])) { frame = speaker[1]; text = speaker[2]; }

    let concurrent = null;
    const inline = text.match(/^\(([^)]+)\)\s*(.*)$/);
    if (inline) {
      concurrent = directionCue(inline[1], line, frameIds);
      text = inline[2];
      if (frame) concurrent.frame = frame;
    }
    const cue = { type: 'speak', text, concurrent, source: line };
    if (frame) cue.frame = frame;
    cues.push(cue);
  }
  return cues;
}

function directionCue(body, source, frameIds) {
  frameIds = frameIds || new Set(['main']);
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
    return {
      type: 'overlay', template: 'lower-third', id: 'lower-third',
      slots: { title: strs[0] || '', subtitle: strs[1] || '' }, source,
    };
  }

  if (head === 'walk' || head === 'enter' || head === 'exit') {
    // [walk to 70] [enter from left] [exit right]
    const arg = parts[parts.length - 1].toLowerCase();
    let x = parseFloat(arg);
    if (head === 'enter') x = 50;
    if (head === 'exit' || arg === 'left' || arg === 'right') {
      if (isNaN(x)) x = arg === 'left' ? -15 : 115;
    }
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

  // [<id> <direction...>] — first token is a known frame id: apply the rest
  // of the direction to that frame.
  if (frameIds.has(head) && parts.length > 1) {
    const sub = directionCue(parts.slice(1).join(' '), source, frameIds);
    sub.frame = head;
    return sub;
  }

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

  for (const cue of cues) {
    if (cue.type === 'setting') {
      settings[cue.key] = cue.value;
      if (cue.key === 'engine') engineOverridden = true;
      if (cue.key === 'voice') voiceOverridden = true;
      continue;
    }
    if (cue.type === 'frame' && cue.character) frameChar[cue.id] = cue.character;
    if (cue.type === 'character') frameChar[cue.frame || 'main'] = cue.name;

    if (cue.type === 'speak') {
      // Resolution: an explicit [engine]/[voice] direction always wins;
      // otherwise use the declared voice of the character in this line's
      // frame; otherwise fall back to the (default) settings.
      const cv = characterVoice(frameChar[cue.frame || 'main']);
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

    // 1x1 gif served after a delay — lets headless screenshots wait for async boot
    if (p === '/slowpx') {
      const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'image/gif' }); res.end(gif); },
        parseInt(url.searchParams.get('d'), 10) || 2500);
      return;
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
