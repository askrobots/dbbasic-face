'use strict';

// ---------------------------------------------------------------- Puppet

class Puppet {
  constructor(stageEl) {
    this.stage = stageEl;
    this.pos = document.getElementById('puppet-pos');
    this.flip = document.getElementById('puppet-flip');
    this.manifest = null;
    this.mouthEls = {};
    this.currentMouth = null;
    this.heldAnims = [];
    this.walkAnim = null;
    this.bobAnim = null;
    this.x = 50;              // percent of stage width
    this.facing = 1;          // 1 = right, -1 = left
    this.source = null;       // current AudioBufferSourceNode
    this.audioCtx = null;
    this.analyser = null;
    this.lipLoop = null;
    this.blinkTimer = null;
    this.view = 'body';
    this.cam = { tx: 0, ty: 0, s: 1 };
    this.camera = document.getElementById('camera');
    this.breathAnim = null;
    this.gazeTimer = null;
  }

  async load(name) {
    this.characterName = name;
    const base = `/characters/${name}/`;
    this.manifest = await (await fetch(base + 'manifest.json')).json();
    const svgText = await (await fetch(base + this.manifest.svg)).text();
    this.flip.innerHTML = svgText;
    const svg = this.flip.querySelector('svg');
    svg.style.height = (this.manifest.height || 300) + 'px';
    svg.style.width = 'auto';
    svg.style.overflow = 'visible';

    this.mouthEls = {};
    for (const [shape, sel] of Object.entries(this.manifest.mouths || {})) {
      this.mouthEls[shape] = this.flip.querySelector(sel);
    }
    this.setMouth(this.manifest.restMouth || 'X');
    this.setX(this.x, 0);
    this.startBlinking();
    this.startIdle();
    requestAnimationFrame(() => this.setView(this.view, true));
  }

  $(sel) { return this.flip.querySelector(sel); }

  setMouth(shape) {
    if (shape === this.currentMouth) return;
    for (const el of Object.values(this.mouthEls)) if (el) el.style.display = 'none';
    const el = this.mouthEls[shape] || this.mouthEls[this.manifest.restMouth || 'X'];
    if (el) el.style.display = '';
    this.currentMouth = shape;
  }

  // ------------------------------------------------------------- speech
  //
  // Playback goes through Web Audio buffers rather than an <audio> element:
  // speak cues arrive over SSE (outside any click), and Safari blocks
  // HTMLMediaElement.play() there. An AudioContext, once resumed by any user
  // gesture, can start buffers at any time.

  ensureCtx() {
    if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return this.audioCtx;
  }

  async speak(cue) {
    this.stopSpeaking();
    const ctx = this.ensureCtx();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

    let buffer;
    try {
      const bytes = await (await fetch(cue.audio)).arrayBuffer();
      buffer = await ctx.decodeAudioData(bytes);
    } catch (e) {
      toast('audio failed: ' + e.message);
      return;
    }

    if (ctx.state !== 'running') {
      toast('🔇 Click anywhere once to enable sound');
      await new Promise((r) => window.addEventListener('pointerdown', r, { once: true }));
      await ctx.resume().catch(() => {});
      if (ctx.state !== 'running') { toast('could not start audio'); return; }
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    src.connect(this.analyser);
    this.analyser.connect(ctx.destination);
    this.source = src;

    const timeline = cue.timeline;
    const data = new Uint8Array(this.analyser.fftSize);
    const startAt = ctx.currentTime;
    const tick = () => {
      if (this.source !== src) return;
      if (timeline && timeline.length) {
        const t = ctx.currentTime - startAt;
        let shape = 'X';
        for (const c of timeline) { if (t >= c.start && t < c.end) { shape = c.value; break; } }
        this.setMouth(shape);
      } else {
        this.analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) { const d = (v - 128) / 128; sum += d * d; }
        const rms = Math.sqrt(sum / data.length);
        this.setMouth(rms > 0.14 ? 'D' : rms > 0.07 ? 'C' : rms > 0.025 ? 'B' : 'X');
      }
      this.lipLoop = requestAnimationFrame(tick);
    };

    await new Promise((resolve) => {
      src.onended = resolve;
      src.start();
      this.lipLoop = requestAnimationFrame(tick);
    });
    if (this.source === src) this.stopSpeaking();
  }

  stopSpeaking() {
    if (this.lipLoop) cancelAnimationFrame(this.lipLoop);
    this.lipLoop = null;
    if (this.source) { try { this.source.stop(); } catch { /* already stopped */ } this.source = null; }
    if (this.manifest) this.setMouth(this.manifest.restMouth || 'X');
  }

  // ------------------------------------------------------------ actions

  act(name) {
    const def = (this.manifest.actions || {})[name];
    if (!def) return Promise.resolve();
    if (def.reset) {
      for (const a of this.heldAnims) a.cancel();
      this.heldAnims = [];
      return Promise.resolve();
    }
    const done = [];
    for (const track of def.tracks) {
      const el = this.$(track.target);
      if (!el) continue;
      if (track.origin) {
        el.style.transformBox = 'fill-box';
        el.style.transformOrigin = track.origin;
      }
      const anim = el.animate(track.keyframes, {
        duration: track.duration || 1000,
        easing: track.easing || 'ease-in-out',
        iterations: track.iterations || 1,
        fill: track.fill || 'none',
      });
      if (track.fill === 'forwards') this.heldAnims.push(anim);
      done.push(anim.finished.catch(() => {}));
    }
    return Promise.all(done);
  }

  // ----------------------------------------------------------- movement

  setX(pct, ms) {
    const el = this.pos;
    if (this.walkAnim) { this.walkAnim.cancel(); this.walkAnim = null; }
    el.style.transition = ms ? `left ${ms}ms linear` : 'none';
    el.style.left = pct + '%';
    this.x = pct;
  }

  face(dir) {
    this.facing = dir;
    this.flip.style.transform = dir < 0 ? 'scaleX(-1)' : '';
  }

  async walkTo(pct, fromSide) {
    if (fromSide === 'left') this.setX(-15, 0);
    if (fromSide === 'right') this.setX(115, 0);
    await new Promise((r) => requestAnimationFrame(r)); // flush the teleport
    const stageW = this.stage.clientWidth;
    const distPx = Math.abs(pct - this.x) / 100 * stageW;
    const speed = (this.manifest.walk && this.manifest.walk.speed) || 220;
    const ms = Math.max(200, distPx / speed * 1000);
    this.face(pct >= this.x ? 1 : -1);

    let bob = null;
    if (!this.manifest.walk || this.manifest.walk.bob !== false) {
      const root = this.$('#puppet') || this.flip.querySelector('svg');
      bob = root.animate(
        [{ transform: 'translateY(0)' }, { transform: 'translateY(-7px)' }, { transform: 'translateY(0)' }],
        { duration: 260, iterations: Math.ceil(ms / 260) });
    }
    this.setX(pct, ms);
    await new Promise((r) => setTimeout(r, ms));
    if (bob) bob.cancel();
    if (this.view === 'face') this.setView('face'); // keep the close-up framed
  }

  lookEls() {
    const cfg = this.manifest.look;
    return cfg ? [...this.flip.querySelectorAll(cfg.target)] : [];
  }

  setGaze(transform, ms) {
    for (const el of this.lookEls()) {
      el.style.transition = `transform ${ms}ms ease`;
      el.style.transform = transform;
    }
  }

  look(dir) {
    const cfg = this.manifest.look;
    if (!cfg) return;
    const dx = cfg.dx || 5, dy = cfg.dy || 2;
    const map = {
      left: `translate(${-dx}px, 0)`, right: `translate(${dx}px, 0)`,
      up: `translate(0, ${-dy * 2}px)`, down: `translate(0, ${dy * 2}px)`,
      front: 'translate(0, 0)',
    };
    this.setGaze(map[dir] || map.front, 200);
  }

  // ------------------------------------------------------------- camera

  /**
   * 'body' shows the whole stage; 'face' zooms the camera onto the
   * character's face (manifest views.face.focus, default #head).
   */
  setView(mode, instant = false) {
    this.view = mode === 'face' ? 'face' : 'body';
    this.camera.style.transition = instant ? 'none' : '';
    if (this.view === 'body') {
      this.cam = { tx: 0, ty: 0, s: 1 };
      this.camera.style.transform = '';
      return;
    }
    const cfg = (this.manifest.views && this.manifest.views.face) || {};
    const el = this.$(cfg.focus || '#head');
    if (!el) return;
    const st = this.stage.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const c = this.cam;
    // element rect in untransformed stage coordinates
    const lx = (r.left - st.left - c.tx) / c.s;
    const ly = (r.top - st.top - c.ty) / c.s;
    const lw = r.width / c.s;
    const lh = r.height / c.s;
    const s = st.height * (cfg.fill || 0.6) / lh;
    const tx = st.width / 2 - (lx + lw / 2) * s;
    const ty = st.height * (cfg.centerY || 0.48) - (ly + lh / 2) * s;
    this.cam = { tx, ty, s };
    this.camera.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  }

  // ---------------------------------------------------------- idle life

  startIdle() {
    this.stopIdle();
    const idle = this.manifest.idle || {};
    if (idle.breathe) {
      const el = this.$(idle.breathe.target);
      if (el) {
        const amt = idle.breathe.amount || 1.4;
        this.breathAnim = el.animate(
          [{ transform: 'translateY(0) scaleY(1)' },
           { transform: `translateY(${-amt}px) scaleY(1.012)` },
           { transform: 'translateY(0) scaleY(1)' }],
          { duration: idle.breathe.period || 4200, iterations: Infinity, easing: 'ease-in-out' });
      }
    }
    if (idle.gaze && this.manifest.look) {
      const drift = () => {
        if (!this.source) { // hold eye contact while speaking
          const cfg = this.manifest.look;
          const dx = (Math.random() * 2 - 1) * (cfg.dx || 5) * 0.7;
          const dy = (Math.random() * 2 - 1) * (cfg.dy || 2) * 0.7;
          this.setGaze(Math.random() < 0.4
            ? 'translate(0,0)' : `translate(${dx}px, ${dy}px)`, 500);
        }
        this.gazeTimer = setTimeout(drift, 3000 + Math.random() * 5000);
      };
      this.gazeTimer = setTimeout(drift, 3500);
    }
  }

  stopIdle() {
    if (this.breathAnim) { this.breathAnim.cancel(); this.breathAnim = null; }
    clearTimeout(this.gazeTimer);
  }

  startBlinking() {
    clearTimeout(this.blinkTimer);
    const cfg = this.manifest.blink;
    if (!cfg) return;
    const blink = () => {
      const el = this.$(cfg.target);
      if (el) {
        el.animate(
          [{ transform: 'scaleY(1)' }, { transform: 'scaleY(0.08)' }, { transform: 'scaleY(1)' }],
          { duration: 140, easing: 'ease-in-out' });
      }
      this.blinkTimer = setTimeout(blink, 2500 + Math.random() * 3000);
    };
    this.blinkTimer = setTimeout(blink, 1500);
  }
}

// ------------------------------------------------------------- cue bus

const puppet = new Puppet(document.getElementById('stage'));

function handleCue(cue) {
  switch (cue.type) {
    case 'speak': puppet.speak(cue); break;
    case 'action': puppet.act(cue.name); break;
    case 'walk': puppet.walkTo(cue.x, cue.jump || cue.from); break;
    case 'look': puppet.look(cue.dir); break;
    case 'view': puppet.setView(cue.mode); break;
    case 'character': loadCharacter(cue.name); break;
    case 'script-start': prompterStart(cue.lines); break;
    case 'script-line': prompterHighlight(cue.index); break;
    case 'script-end': prompterEnd(); break;
    case 'error': toast(cue.message); break;
  }
}

const events = new EventSource('/api/events');
events.onmessage = (e) => handleCue(JSON.parse(e.data));

// Any user gesture unlocks/keeps-alive the audio context, so speech cues
// arriving later over SSE are allowed to make sound (Safari autoplay policy).
// Safari additionally keeps a context inaudible until a source node is
// *started* inside a real gesture, so play one silent sample too.
let audioUnlocked = false;
for (const ev of ['pointerdown', 'keydown']) {
  window.addEventListener(ev, () => {
    const ctx = puppet.ensureCtx();
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    if (!audioUnlocked) {
      try {
        const src = ctx.createBufferSource();
        src.buffer = ctx.createBuffer(1, 1, 22050);
        src.connect(ctx.destination);
        src.start(0);
        audioUnlocked = true;
      } catch { /* retry on next gesture */ }
    }
  }, true);
}

// --------------------------------------------------------- teleprompter

const prompter = document.getElementById('prompter');

function prompterStart(lines) {
  prompter.innerHTML = '';
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = 'p-line';
    div.textContent = line;
    prompter.appendChild(div);
  }
  prompter.classList.add('active');
}

function prompterHighlight(i) {
  const lines = prompter.children;
  for (let j = 0; j < lines.length; j++) lines[j].classList.toggle('now', j === i);
  if (lines[i]) lines[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function prompterEnd() {
  setTimeout(() => prompter.classList.remove('active'), 1500);
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 4000);
}

// ------------------------------------------------------------- controls

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) toast((await r.json()).error || 'request failed');
}

const $id = (i) => document.getElementById(i);

$id('say-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $id('say-text').value.trim();
  if (!text) return;
  post('/api/say', {
    text,
    engine: $id('engine').value,
    voice: $id('voice').value,
  });
});

$id('engine').addEventListener('change', loadVoices);

// audio diagnostics: state readout + a beep through the same output path
$id('beep').onclick = async () => {
  const ctx = puppet.ensureCtx();
  await ctx.resume().catch(() => {});
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0.25;
  osc.frequency.value = 440;
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.4);
};
setInterval(() => {
  const c = puppet.audioCtx;
  $id('audio-state').textContent = 'audio: ' + (c ? c.state : 'not started yet');
}, 500);

async function loadVoices() {
  const engine = $id('engine').value;
  const sel = $id('voice');
  sel.innerHTML = '<option value="">default voice</option>';
  try {
    const { voices } = await (await fetch(`/api/voices?engine=${engine}`)).json();
    for (const v of voices) {
      const o = document.createElement('option');
      o.value = o.textContent = v;
      sel.appendChild(o);
    }
  } catch { /* voice list is a nicety */ }
}

function buildActionButtons() {
  const box = $id('actions');
  box.innerHTML = '';
  for (const name of Object.keys(puppet.manifest.actions || {})) {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => post('/api/cue', { type: 'action', name });
    box.appendChild(b);
  }
  for (const dir of ['left', 'front', 'right']) {
    const b = document.createElement('button');
    b.textContent = `look ${dir}`;
    b.onclick = () => post('/api/cue', { type: 'look', dir });
    box.appendChild(b);
  }
  for (const mode of ['face', 'body']) {
    const b = document.createElement('button');
    b.textContent = `🎥 ${mode}`;
    b.onclick = () => post('/api/cue', { type: 'view', mode });
    box.appendChild(b);
  }
}

$id('walk').addEventListener('change', (e) => {
  post('/api/cue', { type: 'walk', x: parseInt(e.target.value, 10) });
});

$id('run-script').onclick = () => post('/api/script', { script: $id('script').value });
$id('stop-script').onclick = () => post('/api/script/stop', {});

async function loadCharacter(name) {
  await puppet.load(name);
  buildActionButtons();
  const sel = $id('character');
  if (sel.value !== name) sel.value = name;
  const pref = puppet.manifest.voice;
  if (pref) {
    if (pref.engine) $id('engine').value = pref.engine;
    await loadVoices();
    if (pref.voice) $id('voice').value = pref.voice;
  }
}

$id('character').addEventListener('change', (e) => {
  post('/api/cue', { type: 'character', name: e.target.value });
});

// ---------------------------------------------------------------- boot

(async function init() {
  const { characters } = await (await fetch('/api/characters')).json();
  const sel = $id('character');
  for (const c of characters) {
    const o = document.createElement('option');
    o.value = o.textContent = c;
    sel.appendChild(o);
  }
  await loadCharacter(characters[0]);
  if (!puppet.manifest.voice) loadVoices();
  $id('script').value = [
    '# Screenplay: [direction] lines and spoken lines',
    '[enter from left]',
    'Hello! I\'m Pip, your puppet.',
    '(wave) Nice to meet you!',
    '[walk to 75]',
    '[emote surprised]',
    'Whoa, the view is different over here.',
    '[emote neutral] [walk to 40]',
    '(bow) That\'s my act. Thanks for watching!',
  ].join('\n');
})();
