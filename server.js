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
const RHUBARB = findRhubarb();
const PORT = process.env.PORT || 3123;

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

/**
 * Parse a screenplay into a cue list.
 *   [wave]                 → action cue
 *   [walk to 70]           → movement (percent of stage width)
 *   [look left|right|front], [emote happy], [wait 1.5]
 *   [engine espeak], [voice Samantha], [rate 180]  → speech settings
 *   (wave) Hello!          → action fired concurrently with the line
 *   Hello!                 → speech
 */
function parseScript(src) {
  const cues = [];
  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const bracketed = [...line.matchAll(/^\s*\[([^\]]+)\]\s*/g)];
    if (/^(\[[^\]]+\]\s*)+$/.test(line)) {
      for (const m of line.matchAll(/\[([^\]]+)\]/g)) cues.push(directionCue(m[1], line));
      continue;
    }

    let text = line;
    let concurrent = null;
    const inline = text.match(/^\(([^)]+)\)\s*(.*)$/);
    if (inline) { concurrent = directionCue(inline[1], line); text = inline[2]; }
    cues.push({ type: 'speak', text, concurrent, source: line });
  }
  return cues;
}

function directionCue(body, source) {
  const parts = body.trim().split(/\s+/);
  const head = parts[0].toLowerCase();
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
  return { type: 'action', name: head, source };
}

let scriptToken = 0;

async function runScript(src) {
  const token = ++scriptToken;
  const cues = parseScript(src);
  const settings = { engine: 'say', voice: '', rate: 0 };
  broadcast({ type: 'script-start', lines: cues.map((c) => c.source) });

  for (let i = 0; i < cues.length; i++) {
    if (token !== scriptToken) break; // stopped or replaced
    const cue = cues[i];
    broadcast({ type: 'script-line', index: i });

    if (cue.type === 'setting') { settings[cue.key] = cue.value; continue; }
    if (cue.type === 'wait') { await sleep(cue.seconds * 1000); continue; }

    if (cue.type === 'speak') {
      let prepared;
      try {
        prepared = await prepareSpeech({ text: cue.text, ...settings });
      } catch (e) {
        broadcast({ type: 'error', message: e.message });
        continue;
      }
      if (token !== scriptToken) break;
      if (cue.concurrent) broadcast(cue.concurrent);
      broadcast({ type: 'speak', ...prepared });
      await sleep(prepared.duration * 1000 + 300);
      continue;
    }

    broadcast(cue);
    if (cue.type === 'action') await sleep((ACTION_SECONDS[cue.name] || 1) * 1000);
    else if (cue.type === 'walk') await sleep(1200);
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
  '.png': 'image/png',
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
      broadcast({ type: 'speak', ...prepared });
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
      runScript(body.script); // runs in background
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

    // static routes
    if (p.startsWith('/audio/')) return serveFile(res, path.join(CACHE, path.basename(p)));
    if (p.startsWith('/characters/')) {
      const rel = path.normalize(p.slice('/characters/'.length));
      if (rel.startsWith('..')) { res.writeHead(403); return res.end(); }
      return serveFile(res, path.join(CHARACTERS, rel));
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
