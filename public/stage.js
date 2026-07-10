'use strict';

// --------------------------------------------------------------- helpers

function looksLikeUrl(v) {
  return /^([a-z]+:)?\/\//i.test(v) || v.startsWith('/') || /\.[a-z0-9]{2,5}(\?.*)?$/i.test(v);
}

function assetUrl(kind, id) { return `/api/asset/${kind}/${id}`; }

// Named slots resolve to stage-percent rects [x, y, w, h]. `rect:` on a
// frame cue overrides `slot:` entirely.
const SLOTS = {
  full: [0, 0, 100, 100],
  left: [0, 0, 50, 100],
  right: [50, 0, 50, 100],
  'third-l': [0, 0, 33.34, 100],
  'third-c': [33.33, 0, 33.34, 100],
  'third-r': [66.66, 0, 33.34, 100],
  'pip-tr': [66, 4, 30, 30],
  'pip-tl': [4, 4, 30, 30],
  'pip-br': [66, 66, 30, 30],
  'pip-bl': [4, 66, 30, 30],
};

// Layout presets: macros that clear existing frames and create the named ones.
const LAYOUT_PRESETS = {
  single: [{ id: 'main', slot: 'full' }],
  split: [{ id: 'left', slot: 'left' }, { id: 'right', slot: 'right' }],
  thirds: [
    { id: 'third-l', slot: 'third-l' },
    { id: 'third-c', slot: 'third-c' },
    { id: 'third-r', slot: 'third-r' },
  ],
  'pip-tr': [{ id: 'main', slot: 'full' }, { id: 'pip', slot: 'pip-tr' }],
  'pip-tl': [{ id: 'main', slot: 'full' }, { id: 'pip', slot: 'pip-tl' }],
  'pip-br': [{ id: 'main', slot: 'full' }, { id: 'pip', slot: 'pip-br' }],
  'pip-bl': [{ id: 'main', slot: 'full' }, { id: 'pip', slot: 'pip-bl' }],
};

// ---------------------------------------------------------------- Puppet
//
// A Puppet is bound to one frame's DOM subtree
// (.frame-camera > .frame-pos > .frame-flip) rather than fixed page ids, so
// several can exist side by side, one per frame.

class Puppet {
  constructor(frameEl) {
    this.stage = frameEl;               // the frame's own rect (for width/camera math)
    this.camera = frameEl.querySelector('.frame-camera');
    this.pos = frameEl.querySelector('.frame-pos');
    this.flip = frameEl.querySelector('.frame-flip');
    this.manifest = null;
    this.characterName = null;
    this.mouthEls = {};
    this.currentMouth = null;
    this.heldAnims = [];
    this.walkAnim = null;
    this.bobAnim = null;
    this.x = 50;              // percent of frame width
    this.facing = 1;          // 1 = right, -1 = left
    this.source = null;       // current AudioBufferSourceNode
    this.audioCtx = null;
    this.analyser = null;
    this.lipLoop = null;
    this.blinkTimer = null;
    this.view = 'body';
    this.cam = { tx: 0, ty: 0, s: 1 };
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
    if (pct >= 0 && pct <= 100) { // on-stage target: keep the whole character inside the frame
      const charW = this.flip.getBoundingClientRect().width;
      const halfPct = (charW / stageW) * 100 / 2;
      pct = halfPct > 50 ? 50 : Math.min(Math.max(pct, halfPct), 100 - halfPct);
    } // else: deliberate off-stage target (enter/exit) — leave as-is
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
   * 'body' shows the whole frame; 'face' zooms the camera onto the
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
    // element rect in untransformed frame coordinates
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

// ---------------------------------------------------------------- Stage
//
// The Stage owns a map of frames (id -> {el, bgEl, contentEl, puppet}),
// each an independent rectangular sub-stage: background, optional content
// tile, optional character (a Puppet bound to that frame's DOM). Cues route
// by cue.frame, defaulting to the active frame (boots as "main", full-size),
// so with no frame cue ever sent the stage behaves exactly as a single
// puppet on one full-stage frame.

class Stage {
  constructor(framesEl, overlaysEl, captionsEl, takeEl) {
    this.framesEl = framesEl;
    this.overlaysEl = overlaysEl;
    this.frames = new Map();
    this.activeId = 'main';
    this.overlays = new Map();
    this.overlaySeq = 0;
    this.overlayCache = new Map();
    this.autoSlots = ['left', 'right'];
    this.autoIdx = 0;

    // captions: last-speaker-wins subtitle bar, off by default
    this.captionsEl = captionsEl;
    this.captionsOn = false;
    this.captionsTimer = null;

    // take: fullscreen transitions (iris/fade) share one layer + hole child
    this.takeEl = takeEl;
    this.holeEl = takeEl && takeEl.querySelector('.iris-hole');
    this.takeAnim = null;
  }

  ensureFrame(id) { return this.frames.get(id) || this.createFrame(id); }

  createFrame(id) {
    const el = document.createElement('div');
    el.className = 'frame';
    el.dataset.id = id;
    el.innerHTML =
      '<div class="frame-bg"></div>' +
      '<div class="frame-content"></div>' +
      '<div class="frame-camera"><div class="frame-pos"><div class="frame-flip"></div></div></div>';
    this.framesEl.appendChild(el);
    const f = {
      id, el,
      bgEl: el.querySelector('.frame-bg'),
      contentEl: el.querySelector('.frame-content'),
      puppet: null,
    };
    this.frames.set(id, f);
    this.setRect(f, 'full');
    return f;
  }

  setRect(f, slot, rect) {
    const r = rect || SLOTS[slot] || SLOTS.full;
    f.el.style.left = r[0] + '%';
    f.el.style.top = r[1] + '%';
    f.el.style.width = r[2] + '%';
    f.el.style.height = r[3] + '%';
  }

  autoSlot() {
    const slot = this.autoSlots[this.autoIdx] || 'full';
    this.autoIdx = Math.min(this.autoIdx + 1, this.autoSlots.length);
    return slot;
  }

  async loadCharacterInto(f, name) {
    if (!f.puppet) f.puppet = new Puppet(f.el);
    await f.puppet.load(name);
  }

  // -------------------------------------------------------- frame cues

  frame(cue) {
    const existed = this.frames.has(cue.id);
    const f = this.ensureFrame(cue.id);
    if (cue.rect) this.setRect(f, null, cue.rect);
    else if (cue.slot) this.setRect(f, cue.slot);
    else if (!existed) this.setRect(f, this.autoSlot());
    if (cue.bg !== undefined) this.setBg(f, cue.bg);
    if (!cue.character) {
      if (cue.view && f.puppet) f.puppet.setView(cue.view);
      if (cue.facing !== undefined && f.puppet) f.puppet.face(cue.facing);
    }
    this.activeId = cue.id;
    return f;
  }

  frameClear(cue) {
    if (this.frames.size <= 1) return; // never remove the last frame
    const f = this.frames.get(cue.id);
    if (!f) return;
    if (f.puppet) f.puppet.stopSpeaking();
    f.el.remove();
    this.frames.delete(cue.id);
    if (this.activeId === cue.id) {
      this.activeId = this.frames.has('main') ? 'main' : this.frames.keys().next().value;
    }
  }

  layout(cue) {
    const preset = cue.preset || 'single';
    const specs = LAYOUT_PRESETS[preset] || LAYOUT_PRESETS.single;
    const mainF = this.frames.get('main');
    const keepChar = mainF && mainF.puppet ? mainF.puppet.characterName : null;

    for (const f of this.frames.values()) { if (f.puppet) f.puppet.stopSpeaking(); f.el.remove(); }
    this.frames.clear();
    this.autoIdx = 0;

    let firstId = null;
    for (const spec of specs) {
      const f = this.createFrame(spec.id);
      this.setRect(f, spec.slot);
      if (!firstId) firstId = spec.id;
      if (spec.id === 'main' && keepChar) this.loadCharacterInto(f, keepChar);
    }
    this.activeId = this.frames.has('main') ? 'main' : firstId;
  }

  // ------------------------------------------------------------ content

  content(cue) {
    const id = cue.frame || this.activeId;
    if (cue.frame) this.activeId = id;
    this.renderContent(this.ensureFrame(id), cue);
  }

  contentClear(cue) {
    const f = this.frames.get(cue.frame || this.activeId);
    if (f) f.contentEl.innerHTML = '';
  }

  renderContent(f, cue) {
    const el = f.contentEl;
    el.innerHTML = '';
    if (cue.kind === 'image' || cue.kind === 'video') {
      const src = looksLikeUrl(cue.value) ? cue.value : assetUrl('props', cue.value);
      const tag = document.createElement(cue.kind === 'video' ? 'video' : 'img');
      tag.src = src;
      tag.style.maxWidth = '100%';
      tag.style.maxHeight = '100%';
      tag.style.objectFit = cue.fit || 'contain';
      if (cue.kind === 'video') { tag.autoplay = true; tag.loop = true; tag.muted = true; tag.playsInline = true; }
      el.appendChild(tag);
    } else {
      const div = document.createElement('div');
      div.className = 'content-text';
      div.textContent = cue.value;
      el.appendChild(div);
    }
  }

  // -------------------------------------------------------------- scene

  scene(cue) {
    const id = cue.frame || this.activeId;
    if (cue.frame) this.activeId = id;
    this.setBg(this.ensureFrame(id), cue.bg);
  }

  setBg(f, bg) {
    if (bg === undefined) return;
    f.bgEl.innerHTML = '';
    if (!bg) { f.bgEl.style.background = ''; return; }
    if (/^#[0-9a-f]{3,8}$/i.test(bg) || /^(linear|radial)-gradient\(/.test(bg) || looksLikeUrl(bg)) {
      f.bgEl.style.background = /^(linear|radial)-gradient\(/.test(bg) || bg.startsWith('#')
        ? bg : `center / cover no-repeat url("${bg}")`;
      return;
    }
    this.loadBgAsset(f, bg); // asset id: resolve against assets/backgrounds/<id>.*
  }

  async loadBgAsset(f, id) {
    try {
      const res = await fetch(assetUrl('backgrounds', id));
      if (!res.ok) throw new Error('missing asset');
      const ctype = res.headers.get('content-type') || '';
      if (ctype.includes('svg')) {
        f.bgEl.innerHTML = await res.text();
        f.bgEl.style.background = '';
      } else {
        f.bgEl.style.background = `center / cover no-repeat url("${res.url}")`;
      }
    } catch { /* asset pack may not have this id yet; leave background as-is */ }
  }

  // ----------------------------------------------------------- overlays

  overlay(cue) {
    const id = cue.id || `ov${++this.overlaySeq}`;
    let ov = this.overlays.get(id);
    if (!ov) {
      ov = document.createElement('div');
      ov.className = 'overlay';
      this.overlaysEl.appendChild(ov);
      this.overlays.set(id, ov);
    }
    clearTimeout(ov._holdTimer);
    ov.dataset.enter = cue.enter || '';
    ov.dataset.exit = cue.exit || '';
    this.renderOverlay(ov, cue.template, cue.slots || {});
    requestAnimationFrame(() => ov.classList.add('shown'));
    if (cue.hold) ov._holdTimer = setTimeout(() => this.overlayClear({ id }), cue.hold);
  }

  overlayClear(cue) {
    const removeOne = (id) => {
      const ov = this.overlays.get(id);
      if (!ov) return;
      clearTimeout(ov._holdTimer);
      this.overlays.delete(id);
      ov.classList.remove('shown');
      setTimeout(() => ov.remove(), 400);
    };
    if (cue && cue.id) { removeOne(cue.id); return; }
    for (const id of [...this.overlays.keys()]) removeOne(id);
  }

  async renderOverlay(ov, template, slots) {
    let html = this.overlayCache.get(template);
    if (html === undefined) {
      try { html = await (await fetch(assetUrl('overlays', template))).text(); }
      catch { html = ''; }
      this.overlayCache.set(template, html);
    }
    ov.innerHTML = html;
    for (const [key, val] of Object.entries(slots)) {
      const el = ov.querySelector(`[data-slot="${key}"]`);
      if (el) el.textContent = val;
    }
  }

  // ------------------------------------------------------------ captions

  captions(cue) {
    this.captionsOn = cue.on !== false;
    if (!this.captionsOn) this.hideCaption();
  }

  showCaption(cue) {
    if (!this.captionsOn) return;
    clearTimeout(this.captionsTimer);
    this.captionsEl.textContent = cue.text;
    this.captionsEl.classList.add('shown');
    this.captionsTimer = setTimeout(() => this.hideCaption(), (cue.duration || 0) * 1000 + 300);
  }

  hideCaption() {
    clearTimeout(this.captionsTimer);
    this.captionsTimer = null;
    this.captionsEl.classList.remove('shown');
    this.captionsEl.textContent = '';
  }

  // --------------------------------------------------------- transitions
  //
  // #take is one shared layer for both fade and iris: fade animates the
  // layer's own opacity (a flat black fill); iris animates a child "hole"
  // element's diameter, whose box-shadow paints black everywhere outside
  // it (clipped to #stage by #stage's overflow:hidden). Each call resets
  // whichever mode isn't in use so the two never fight over #take's state.

  transition(cue) {
    if (this.takeAnim) { this.takeAnim.cancel(); this.takeAnim = null; }
    const ms = cue.ms || 700;
    if (cue.name === 'iris') this.irisTransition(cue.dir, ms);
    else this.fadeTransition(cue.dir, ms);
  }

  fadeTransition(dir, ms) {
    const el = this.takeEl;
    if (this.holeEl) this.holeEl.style.display = 'none';
    el.style.display = 'block';
    el.style.background = '#000';
    const from = dir === 'in' ? 1 : 0;
    const to = dir === 'in' ? 0 : 1;
    el.style.opacity = from;
    const anim = el.animate([{ opacity: from }, { opacity: to }], { duration: ms, easing: 'linear', fill: 'forwards' });
    this.takeAnim = anim;
    anim.finished.then(() => {
      if (this.takeAnim !== anim) return;
      el.style.opacity = to;
      if (dir === 'in') el.style.display = 'none';
    }).catch(() => {});
  }

  irisTransition(dir, ms) {
    const el = this.takeEl;
    const hole = this.holeEl;
    if (!hole) return;
    el.style.background = 'transparent';
    el.style.opacity = '1';
    el.style.display = 'block';
    hole.style.display = 'block';
    const full = Math.hypot(el.clientWidth, el.clientHeight) + 100; // fully clears the stage
    const from = dir === 'in' ? 0 : full;
    const to = dir === 'in' ? full : 0;
    hole.style.width = from + 'px';
    hole.style.height = from + 'px';
    const anim = hole.animate(
      [{ width: from + 'px', height: from + 'px' }, { width: to + 'px', height: to + 'px' }],
      { duration: ms, easing: 'linear', fill: 'forwards' });
    this.takeAnim = anim;
    anim.finished.then(() => {
      if (this.takeAnim !== anim) return;
      hole.style.width = to + 'px';
      hole.style.height = to + 'px';
      if (dir === 'in') { el.style.display = 'none'; hole.style.display = 'none'; }
    }).catch(() => {});
  }

  // ----------------------------------------------- character direction

  forFrame(cue) {
    const id = cue.frame || this.activeId;
    if (cue.frame) this.activeId = id;
    return this.ensureFrame(id).puppet;
  }
}

// ------------------------------------------------------------- cue bus

const $id = (i) => document.getElementById(i);

const stage = new Stage($id('frames'), $id('overlays'), $id('captions'), $id('take'));
stage.ensureFrame('main'); // boots as one full-size frame + the default character

function mainPuppet() {
  const f = stage.frames.get('main');
  return f && f.puppet;
}

function handleCue(cue) {
  switch (cue.type) {
    case 'frame': {
      const f = stage.frame(cue);
      if (cue.character) loadCharacter(cue.character, f.id, { view: cue.view, facing: cue.facing });
      break;
    }
    case 'frame-clear': stage.frameClear(cue); break;
    case 'layout': stage.layout(cue); break;
    case 'content': stage.content(cue); break;
    case 'content-clear': stage.contentClear(cue); break;
    case 'scene': stage.scene(cue); break;
    case 'overlay': stage.overlay(cue); break;
    case 'overlay-clear': stage.overlayClear(cue); break;
    case 'captions': stage.captions(cue); break;
    case 'transition': stage.transition(cue); break;
    case 'speak': {
      const p = stage.forFrame(cue);
      if (p) p.speak(cue);
      stage.showCaption(cue);
      break;
    }
    case 'action': { const p = stage.forFrame(cue); if (p) p.act(cue.name); break; }
    case 'walk': { const p = stage.forFrame(cue); if (p) p.walkTo(cue.x, cue.jump || cue.from); break; }
    case 'look': { const p = stage.forFrame(cue); if (p) p.look(cue.dir); break; }
    case 'view': { const p = stage.forFrame(cue); if (p) p.setView(cue.mode); break; }
    case 'character': {
      const id = cue.frame || stage.activeId;
      if (cue.frame) stage.activeId = id;
      loadCharacter(cue.name, id);
      break;
    }
    case 'script-start':
      for (const f of stage.frames.values()) if (f.puppet) f.puppet.stopSpeaking();
      prompterStart(cue.lines);
      break;
    case 'script-line': prompterHighlight(cue.index); break;
    case 'script-end': prompterEnd(); break;
    case 'error': toast(cue.message); break;
  }
}

const events = new EventSource('/api/events');
events.onmessage = (e) => handleCue(JSON.parse(e.data));

// Any user gesture unlocks/keeps-alive every puppet's audio context, so
// speech cues arriving later over SSE are allowed to make sound (Safari
// autoplay policy). Safari additionally keeps a context inaudible until a
// source node is *started* inside a real gesture, so play one silent sample
// per context too.
const unlockedCtxs = new WeakSet();
function unlockAudio(p) {
  if (!p) return;
  const ctx = p.ensureCtx();
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
  if (!unlockedCtxs.has(ctx)) {
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, 22050);
      src.connect(ctx.destination);
      src.start(0);
      unlockedCtxs.add(ctx);
    } catch { /* retry on next gesture */ }
  }
}
for (const ev of ['pointerdown', 'keydown']) {
  window.addEventListener(ev, () => {
    for (const f of stage.frames.values()) if (f.puppet) unlockAudio(f.puppet);
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
//
// The control panel always targets the "main" frame explicitly, exactly as
// the single-puppet stage did before frames existed — it has no frame
// picker, regardless of whatever frame a screenplay may have made active.

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) toast((await r.json()).error || 'request failed');
}

$id('say-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $id('say-text').value.trim();
  if (!text) return;
  post('/api/say', {
    text,
    engine: $id('engine').value,
    voice: $id('voice').value,
    frame: 'main',
  });
});

$id('engine').addEventListener('change', loadVoices);

// audio diagnostics: state readout + a beep through the same output path
$id('beep').onclick = async () => {
  const ctx = mainPuppet().ensureCtx();
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
  const p = mainPuppet();
  const c = p && p.audioCtx;
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
  const p = mainPuppet();
  for (const name of Object.keys((p.manifest || {}).actions || {})) {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => post('/api/cue', { type: 'action', name, frame: 'main' });
    box.appendChild(b);
  }
  for (const dir of ['left', 'front', 'right']) {
    const b = document.createElement('button');
    b.textContent = `look ${dir}`;
    b.onclick = () => post('/api/cue', { type: 'look', dir, frame: 'main' });
    box.appendChild(b);
  }
  for (const mode of ['face', 'body']) {
    const b = document.createElement('button');
    b.textContent = `🎥 ${mode}`;
    b.onclick = () => post('/api/cue', { type: 'view', mode, frame: 'main' });
    box.appendChild(b);
  }
}

$id('walk').addEventListener('change', (e) => {
  post('/api/cue', { type: 'walk', x: parseInt(e.target.value, 10), frame: 'main' });
});

// -------------------------------------------------------------- scene

for (const btn of document.querySelectorAll('#layout-buttons button')) {
  btn.onclick = () => post('/api/cue', { type: 'layout', preset: btn.dataset.preset });
}

$id('scene-bg').addEventListener('change', (e) => {
  const bg = e.target.value;
  if (!bg) return;
  post('/api/cue', { type: 'scene', bg }); // targets the active frame server-side
  e.target.value = ''; // picker, not a state display
});

let captionsOn = false;
$id('captions-toggle').onclick = (e) => {
  captionsOn = !captionsOn;
  post('/api/cue', { type: 'captions', on: captionsOn });
  e.target.textContent = captionsOn ? 'CC on' : 'CC off';
  e.target.classList.toggle('on', captionsOn);
};

for (const btn of document.querySelectorAll('[data-transition-name]')) {
  btn.onclick = () => post('/api/cue', {
    type: 'transition', name: btn.dataset.transitionName, dir: btn.dataset.transitionDir,
  });
}

async function loadAssets() {
  try {
    const { backgrounds } = await (await fetch('/api/assets')).json();
    const sel = $id('scene-bg');
    if (!backgrounds || !backgrounds.length) { sel.style.display = 'none'; return; }
    for (const id of backgrounds) {
      const o = document.createElement('option');
      o.value = o.textContent = id;
      sel.appendChild(o);
    }
  } catch { /* asset list is a nicety */ }
}

// ---------------------------------------------------------------- examples

async function loadExamples() {
  try {
    const { examples } = await (await fetch('/api/examples')).json();
    const row = $id('example-row');
    if (!examples || !examples.length) { row.style.display = 'none'; return; }
    const sel = $id('example');
    for (const name of examples) {
      const o = document.createElement('option');
      o.value = o.textContent = name;
      sel.appendChild(o);
    }
  } catch { /* example list is a nicety */ }
}

$id('load-example').onclick = async () => {
  const name = $id('example').value;
  if (!name) return;
  try {
    const { script } = await (await fetch(`/api/examples/${encodeURIComponent(name)}`)).json();
    $id('script').value = script;
  } catch { toast('could not load example'); }
};

$id('run-script').onclick = () => {
  const p = mainPuppet();
  post('/api/script', { script: $id('script').value, mainCharacter: p && p.characterName });
};
$id('stop-script').onclick = () => post('/api/script/stop', {});

async function loadCharacter(name, frameId = 'main', extra = {}) {
  const f = stage.ensureFrame(frameId);
  await stage.loadCharacterInto(f, name);
  if (extra.view) f.puppet.setView(extra.view, true);
  if (extra.facing !== undefined) f.puppet.face(extra.facing);
  if (frameId !== 'main') return;

  buildActionButtons();
  const sel = $id('character');
  if (sel.value !== name) sel.value = name;
  const pref = f.puppet.manifest.voice;
  if (pref) {
    if (pref.engine) $id('engine').value = pref.engine;
    await loadVoices();
    if (pref.voice) $id('voice').value = pref.voice;
  }
}

$id('character').addEventListener('change', (e) => {
  post('/api/cue', { type: 'character', name: e.target.value, frame: 'main' });
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
  await loadCharacter(characters[0], 'main');
  if (!mainPuppet().manifest.voice) loadVoices();
  loadAssets();
  loadExamples();
  $id('script').value = [
    '# Try an example from the picker above, or run this:',
    '[captions on]',
    '[fade in 800]',
    'Hello! Welcome to the puppet stage.',
    '(wave) Every line here is a cue.',
    '[view face]',
    'The camera can come in close…',
    '[view body] [walk to 65]',
    '…and I can move around the stage.',
    '(bow) Load an example above to see a real show.',
    '[iris out 1000]',
  ].join('\n');
})();
