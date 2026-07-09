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
    async deliver(cue) {
      if (cue.type === 'say-text') {
        const d = await renderSpeech(cue);
        cue = d.status === 'ok'
          ? { type: 'speak', audio: d.audio, timeline: d.timeline, duration: d.duration, text: d.text }
          : { type: 'error', message: d.error || 'speech failed' };
      }
      if (this.onmessage) this.onmessage({ data: JSON.stringify(cue) });
    }
  }
  window.EventSource = function () { return new PollingEventSource(); };

  // ------------------------------------------------- screenplay (client)

  function directionCue(body) {
    const parts = body.trim().split(/\s+/);
    const head = parts[0].toLowerCase();
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
    return { type: 'action', name: head };
  }

  function parseScript(src) {
    const cues = [];
    for (const rawLine of src.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (/^(\[[^\]]+\]\s*)+$/.test(line)) {
        for (const m of line.matchAll(/\[([^\]]+)\]/g)) cues.push({ ...directionCue(m[1]), source: line });
        continue;
      }
      let text = line;
      let concurrent = null;
      const inline = text.match(/^\(([^)]+)\)\s*(.*)$/);
      if (inline) { concurrent = { ...directionCue(inline[1]), source: line }; text = inline[2]; }
      cues.push({ type: 'speak-line', text, concurrent, source: line });
    }
    return cues;
  }

  const ACTION_SECONDS = { wave: 1.6, jump: 0.9, nod: 1.2, shake: 1.2, bow: 1.8, dance: 2.4, shrug: 1.1 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let scriptToken = 0;

  async function runScript(src) {
    const token = ++scriptToken;
    const cues = parseScript(src);
    const settings = { engine: 'say', voice: '', rate: 0 };
    await postCue({ type: 'script-start', lines: cues.map((c) => c.source) });

    for (let i = 0; i < cues.length; i++) {
      if (token !== scriptToken) break;
      const cue = cues[i];
      await postCue({ type: 'script-line', index: i });

      if (cue.type === 'setting') { settings[cue.key] = cue.value; continue; }
      if (cue.type === 'wait') { await sleep(cue.seconds * 1000); continue; }

      if (cue.type === 'speak-line') {
        // render once to learn the real duration, then broadcast; each
        // stage re-renders the (deterministic) audio on receipt
        const d = await renderSpeech({ text: cue.text, ...settings });
        if (token !== scriptToken) break;
        if (cue.concurrent) await postCue(cue.concurrent);
        await postCue({ type: 'say-text', text: cue.text, ...settings });
        await sleep(((d.duration || cue.text.split(/\s+/).length * 0.35) * 1000) + 400);
        continue;
      }

      await postCue(cue);
      if (cue.type === 'action') await sleep((ACTION_SECONDS[cue.name] || 1) * 1000);
      else if (cue.type === 'walk') await sleep(1200);
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
      runScript(JSON.parse(opts.body || '{}').script || ''); // fire and forget
      return jsonResponse({ ok: true });
    }
    if (u === '/api/script/stop') {
      scriptToken++;
      postCue({ type: 'script-end' });
      return jsonResponse({ ok: true });
    }
    return realFetch(url, opts);
  };
})();
