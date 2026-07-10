// DBBASIC adapter shim for the Puppet Stage frontend.
//
// Loaded BEFORE the verbatim stage.js. Translates the stage's native
// protocol (SSE + /api/* + /characters/*) onto DBBASIC objects:
//   puppet_cues  — polled cue queue (the object server has no SSE yet)
//   puppet_speak — TTS + Rhubarb, returns audio as a data: URI
// Characters are embedded in the page (window.PUPPET_CHARACTERS), and the
// screenplay runner executes client-side, broadcasting cues through the
// queue so every open stage plays the same show.
'use strict';
(() => {
  const CUES_URL = '/objects/puppet_cues';
  const SPEAK_URL = '/objects/puppet_speak';
  const POLL_MS = 350;
  const CHARACTERS = window.PUPPET_CHARACTERS || {};
  const EXAMPLES = window.PUPPET_EXAMPLES || {};
  const realFetch = window.fetch.bind(window);

  const jsonResponse = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

  async function postCue(cue) {
    const r = await realFetch(CUES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cue),
    });
    return r.json();
  }

  async function renderSpeech(body) {
    const r = await realFetch(SPEAK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.json();
  }

  // ---------------------------------------------------------- EventSource

  class PollingEventSource {
    constructor() {
      this.onmessage = null;
      this.seq = null;
      this.chain = Promise.resolve(); // deliver cues in order
      this.poll();
    }
    async poll() {
      try {
        const url = this.seq === null ? `${CUES_URL}?tail=1` : `${CUES_URL}?since=${this.seq}`;
        const d = await (await realFetch(url)).json();
        if (d.status === 'ok') {
          if (this.seq !== null) {
            for (const cue of d.cues) this.chain = this.chain.then(() => this.deliver(cue));
          }
          this.seq = d.seq;
        }
      } catch { /* server briefly unreachable; keep polling */ }
      setTimeout(() => this.poll(), POLL_MS);
    }
    async deliver(rawCue) {
      let cue = rawCue;
      if (rawCue.type === 'say-text') {
        const d = await renderSpeech(rawCue);
        cue = d.status === 'ok'
          ? { type: 'speak', audio: d.audio, timeline: d.timeline, duration: d.duration, text: d.text }
          : { type: 'error', message: d.error || 'speech failed' };
        if (cue.type === 'speak' && rawCue.frame) cue.frame = rawCue.frame;
      }
      if (this.onmessage) this.onmessage({ data: JSON.stringify(cue) });
    }
  }
  window.EventSource = function () { return new PollingEventSource(); };

  // ------------------------------------------------- screenplay (client)
  //
  // Grammar mirrors server.js parseScript/directionCue exactly — keep the
  // two in sync when either changes.

  const LAYOUT_FRAMES = {
    single: ['main'],
    split: ['left', 'right'],
    thirds: ['third-l', 'third-c', 'third-r'],
    'pip-tr': ['main', 'pip'], 'pip-tl': ['main', 'pip'],
    'pip-br': ['main', 'pip'], 'pip-bl': ['main', 'pip'],
  };

  function parseKV(str) {
    const out = {};
    const re = /([a-z][\w-]*):("([^"]*)"|\S+)/gi;
    let m;
    while ((m = re.exec(str))) out[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[2];
    return out;
  }

  function directionCue(body, frameIds) {
    frameIds = frameIds || new Set(['main']);
    const parts = body.trim().split(/\s+/);
    const head = parts[0].toLowerCase();

    if (head === 'layout') {
      const preset = (parts[1] || 'single').toLowerCase();
      const ids = LAYOUT_FRAMES[preset] || ['main'];
      frameIds.clear();
      for (const id of ids) frameIds.add(id);
      return { type: 'layout', preset };
    }

    if (head === 'frame') {
      const id = parts[1];
      const restStr = parts.slice(2).join(' ');
      if (/^clear\b/i.test(restStr)) {
        frameIds.delete(id);
        return { type: 'frame-clear', id };
      }
      const kv = parseKV(restStr);
      const cue = { type: 'frame', id };
      if (kv.slot) cue.slot = kv.slot;
      if (kv.bg) cue.bg = kv.bg;
      if (kv.character) cue.character = kv.character;
      if (kv.view) cue.view = kv.view;
      if (kv.facing !== undefined) cue.facing = parseInt(kv.facing, 10);
      if (kv.rect) cue.rect = kv.rect.split(',').map(Number);
      frameIds.add(id);
      return cue;
    }

    if (head === 'scene') return { type: 'scene', bg: parts.slice(1).join(' ') };

    if (head === 'show') {
      const kv = parseKV(parts.slice(1).join(' '));
      let kind = 'text', value = '';
      for (const k of ['text', 'image', 'video']) {
        if (kv[k] !== undefined) { kind = k; value = kv[k]; break; }
      }
      const cue = { type: 'content', kind, value };
      if (kv.fit) cue.fit = kv.fit;
      return cue;
    }

    if (head === 'lower-third') {
      if ((parts[1] || '').toLowerCase() === 'clear' && !body.includes('"')) {
        return { type: 'overlay-clear', id: 'lower-third' };
      }
      const strs = [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
      return { type: 'overlay', template: 'lower-third', id: 'lower-third', slots: { title: strs[0] || '', subtitle: strs[1] || '' } };
    }

    if (head === 'walk' || head === 'enter' || head === 'exit') {
      const arg = parts[parts.length - 1].toLowerCase();
      let x = parseFloat(arg);
      if (head === 'enter') x = 50;
      if (head === 'exit' || arg === 'left' || arg === 'right') {
        if (isNaN(x)) x = arg === 'left' ? -15 : 115;
      }
      const from = parts.includes('from') ? parts[parts.indexOf('from') + 1] || '' : null;
      return { type: 'walk', x, from, jump: head === 'enter' ? from : null };
    }
    if (head === 'wait') return { type: 'wait', seconds: parseFloat(parts[1]) || 1 };
    if (head === 'view' || head === 'zoom') return { type: 'view', mode: (parts[1] || 'body').toLowerCase() };
    if (head === 'look') return { type: 'look', dir: parts[1] || 'front' };
    if (head === 'emote') return { type: 'action', name: parts[1] || 'neutral' };
    if (head === 'engine' || head === 'voice' || head === 'rate') {
      return { type: 'setting', key: head, value: parts.slice(1).join(' ') };
    }
    if (head === 'captions') {
      const arg = (parts[1] || 'on').toLowerCase();
      return { type: 'captions', on: arg !== 'off' };
    }
    if (head === 'iris' || head === 'fade') {
      const ms = parseInt(parts[2], 10);
      return { type: 'transition', name: head, dir: (parts[1] || 'out').toLowerCase(), ms: isNaN(ms) ? 700 : ms };
    }

    if (frameIds.has(head) && parts.length > 1) {
      const sub = directionCue(parts.slice(1).join(' '), frameIds);
      sub.frame = head;
      return sub;
    }

    return { type: 'action', name: head };
  }

  function parseScript(src) {
    const cues = [];
    const frameIds = new Set(['main']);
    for (const rawLine of src.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (/^(\[[^\]]+\]\s*)+$/.test(line)) {
        for (const m of line.matchAll(/\[([^\]]+)\]/g)) cues.push({ ...directionCue(m[1], frameIds), source: line });
        continue;
      }

      let text = line;
      let frame = null;
      const speaker = text.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
      if (speaker && frameIds.has(speaker[1])) { frame = speaker[1]; text = speaker[2]; }

      let concurrent = null;
      const inline = text.match(/^\(([^)]+)\)\s*(.*)$/);
      if (inline) {
        concurrent = { ...directionCue(inline[1], frameIds), source: line };
        text = inline[2];
        if (frame) concurrent.frame = frame;
      }
      const cue = { type: 'speak-line', text, concurrent, source: line };
      if (frame) cue.frame = frame;
      cues.push(cue);
    }
    return cues;
  }

  const ACTION_SECONDS = { wave: 1.6, jump: 0.9, nod: 1.2, shake: 1.2, bow: 1.8, dance: 2.4, shrug: 1.1 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let scriptToken = 0;

  // Single ordered pass over a parsed cue list that replays the same
  // settings/frameChar/override-flag state runScript used to thread through
  // its loop, attaching the fully-resolved TTS params to every speak-line
  // cue as `cue.resolved`. Mirrors server.js's resolveSpeech so voices stay
  // identical; pulling it out lets runScript render speech ahead of when a
  // line is posted instead of only right before.
  function resolveSpeech(cues, mainCharacter) {
    const settings = { engine: 'say', voice: '', rate: 0 };
    let engineOverridden = false;
    let voiceOverridden = false;
    // frame id -> character name; mirrors server.js's resolution so a
    // screenplay sounds the same whether it runs against the real server or
    // this shim. Seeded with the client's notion of who's in the main frame.
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

      if (cue.type === 'speak-line') {
        // Resolution: an explicit [engine]/[voice] direction always wins;
        // otherwise use the declared voice of the character in this line's
        // frame; otherwise fall back to the (default) settings.
        const ch = CHARACTERS[frameChar[cue.frame || 'main']];
        const cv = ch && ch.manifest && ch.manifest.voice;
        const engine = engineOverridden ? settings.engine : (cv && cv.engine) || settings.engine;
        const voice = voiceOverridden ? settings.voice : (cv && cv.voice !== undefined ? cv.voice : settings.voice);
        cue.resolved = { engine, voice, rate: settings.rate };
      }
    }
  }

  const RENDER_WINDOW = 4;

  async function runScript(src, mainCharacter) {
    const token = ++scriptToken;
    const cues = parseScript(src);
    resolveSpeech(cues, mainCharacter);
    const speakCues = cues.filter((c) => c.type === 'speak-line');

    // Bounded render-ahead: kick off renderSpeech for the k-th speak-line
    // cue at most once, stashing the promise on the cue itself (learns the
    // real duration; each stage re-renders the deterministic audio on
    // receipt of the say-text cue). Safe to call repeatedly.
    function ensureRender(k) {
      if (k < 0 || k >= speakCues.length) return;
      const c = speakCues[k];
      if (!c._renderP) {
        c._renderP = renderSpeech({ text: c.text, ...c.resolved });
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

    await postCue({ type: 'script-start', lines: cues.map((c) => c.source) });

    for (let i = 0; i < cues.length; i++) {
      if (token !== scriptToken) break;
      const cue = cues[i];
      await postCue({ type: 'script-line', index: i });

      if (cue.type === 'setting' || cue.type === 'wait') {
        if (cue.type === 'wait') await sleep(cue.seconds * 1000);
        continue;
      }

      if (cue.type === 'speak-line') {
        const k = speakIndex++;
        ensureRender(k); // in case it wasn't primed (e.g. window > remaining lines)
        const d = await cue._renderP;
        if (token !== scriptToken) break;
        if (cue.concurrent) await postCue(cue.concurrent);
        const sayCue = { type: 'say-text', text: cue.text, ...cue.resolved };
        if (cue.frame) sayCue.frame = cue.frame;
        await postCue(sayCue);
        await sleep(((d.duration || cue.text.split(/\s+/).length * 0.35) * 1000) + 400);
        ensureRender(k + RENDER_WINDOW);
        continue;
      }

      await postCue(cue);
      if (cue.type === 'action') await sleep((ACTION_SECONDS[cue.name] || 1) * 1000);
      else if (cue.type === 'walk') await sleep(1200);
      else if (cue.type === 'transition') await sleep(cue.ms + 100);
      else await sleep(400);
    }
    if (token === scriptToken) await postCue({ type: 'script-end' });
  }

  // -------------------------------------------------------- fetch bridge

  window.fetch = async (url, opts = {}) => {
    const u = String(url);

    if (u === '/api/characters') {
      return jsonResponse({ characters: Object.keys(CHARACTERS) });
    }
    if (u.startsWith('/characters/')) {
      const [, , name, file] = u.split('/');
      const ch = CHARACTERS[name];
      if (!ch) return jsonResponse({ error: 'unknown character' }, 404);
      if (file === 'manifest.json') return jsonResponse(ch.manifest);
      return new Response(ch.svg, { status: 200, headers: { 'Content-Type': 'image/svg+xml' } });
    }
    if (u.startsWith('/api/voices')) {
      const engine = new URLSearchParams(u.split('?')[1] || '').get('engine') || 'say';
      const d = await (await realFetch(`${SPEAK_URL}?voices=1&engine=${engine}`)).json();
      return jsonResponse({ voices: d.voices || [] });
    }
    if (u === '/api/say') {
      const body = JSON.parse(opts.body || '{}');
      const d = await postCue({ type: 'say-text', ...body });
      return jsonResponse(d.status === 'ok' ? { ok: true } : { error: d.error }, d.status === 'ok' ? 200 : 500);
    }
    if (u === '/api/cue') {
      const d = await postCue(JSON.parse(opts.body || '{}'));
      return jsonResponse(d.status === 'ok' ? { ok: true } : { error: d.error }, d.status === 'ok' ? 200 : 500);
    }
    if (u === '/api/script') {
      const body = JSON.parse(opts.body || '{}');
      runScript(body.script || '', body.mainCharacter); // fire and forget
      return jsonResponse({ ok: true });
    }
    if (u === '/api/script/stop') {
      scriptToken++;
      postCue({ type: 'script-end' });
      return jsonResponse({ ok: true });
    }
    if (u === '/api/examples') {
      return jsonResponse({ examples: Object.keys(EXAMPLES).sort() });
    }
    if (u.startsWith('/api/examples/')) {
      const name = decodeURIComponent(u.slice('/api/examples/'.length));
      const script = EXAMPLES[name];
      if (script === undefined) return jsonResponse({ error: 'example not found' }, 404);
      return jsonResponse({ name, script });
    }
    if (u === '/api/assets') {
      // the package page has no asset serving; the UI hides pickers that get
      // empty lists back.
      return jsonResponse({ backgrounds: [], props: [], overlays: [] });
    }
    return realFetch(url, opts);
  };
})();
