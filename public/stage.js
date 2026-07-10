'use strict';

// --------------------------------------------------------------- helpers

function looksLikeUrl(v) {
  return /^([a-z]+:)?\/\//i.test(v) || v.startsWith('/') || /\.[a-z0-9]{2,5}(\?.*)?$/i.test(v);
}

function assetUrl(kind, id) { return `/api/asset/${kind}/${id}`; }

// Design-height reference for prop actors, matching the same 720-design
// scaling rule characters use (Puppet.applyScale): a full-height character
// reads around 600px tall in the 720-tall design, so a prop `scale: 0.3`
// (against this same reference) lands knee-high.
const PROP_DESIGN_HEIGHT = 600;

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
    this.actorScale = 1;         // extra multiplier for actor instances (place cue's scale:)
    this.wornProps = new Map();  // anchor name -> the <g class="worn"> element pinned there
    this.ducking = false;        // true while this puppet holds a musicEngine.duck() (paired with unduck() in stopSpeaking)
  }

  async load(name) {
    this.characterName = name;
    const base = `/characters/${name}/`;
    this.manifest = await (await fetch(base + 'manifest.json')).json();
    const svgText = await (await fetch(base + this.manifest.svg)).text();
    this.flip.innerHTML = svgText;
    const svg = this.flip.querySelector('svg');
    this.svg = svg;
    svg.style.width = 'auto';
    svg.style.overflow = 'visible';
    this.applyScale();

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

  // manifest.height is a DESIGN height authored against a 720px-tall stage;
  // rendering it at that literal pixel size made a character overflow (or
  // shrink to nothing in) its frame whenever the frame wasn't 720px tall —
  // e.g. any browser resize, or a split/thirds layout. Scaling it by the
  // frame's actual height keeps the character the same PROPORTION of its
  // frame at any size.
  applyScale() {
    if (!this.svg) return;
    const designH = (this.manifest && this.manifest.height) || 300;
    const frameH = this.stage.clientHeight || 720;
    this.svg.style.height = Math.max(60, designH * this.actorScale * (frameH / 720)) + 'px';
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
      this.ducking = true;
      if (musicEngine) musicEngine.duck();
      this.lipLoop = requestAnimationFrame(tick);
    });
    if (this.source === src) this.stopSpeaking();
  }

  stopSpeaking() {
    if (this.lipLoop) cancelAnimationFrame(this.lipLoop);
    this.lipLoop = null;
    if (this.source) { try { this.source.stop(); } catch { /* already stopped */ } this.source = null; }
    if (this.ducking) { this.ducking = false; if (musicEngine) musicEngine.unduck(); }
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

  // ----------------------------------------------------------- wearables
  //
  // A worn prop is a <g class="worn"> injected as a following sibling of
  // the anchor element, so it inherits that element's parent transforms
  // (head bobs/nods) automatically. Placement: bottom-center of the prop
  // sits at top-center of the anchor's bbox; width = anchor bbox width x
  // the wear's scale (default 1); height keeps the prop's own aspect via
  // its viewBox. Stored per anchor so a second wear on the same anchor
  // replaces the first.

  async wear(anchor, propId, scale = 1) {
    const anchorSel = (this.manifest.anchors && this.manifest.anchors[anchor]) || '#head';
    const anchorEl = this.$(anchorSel);
    if (!anchorEl) { toast(`wear: no anchor "${anchor}" on ${this.characterName}`); return; }

    let res;
    try {
      res = await fetch(assetUrl('props', propId));
      if (!res.ok) throw new Error('missing asset');
    } catch {
      toast(`wear: missing prop "${propId}"`);
      return;
    }
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('svg')) {
      toast(`wear: prop "${propId}" isn't vector art (wearables need SVG)`);
      return;
    }
    const svgText = await res.text();
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const propSvg = doc.documentElement;
    if (!propSvg || propSvg.nodeName !== 'svg' || doc.querySelector('parsererror')) {
      toast(`wear: invalid prop asset "${propId}"`);
      return;
    }

    const vbParts = (propSvg.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
    const hasVb = vbParts.length === 4 && vbParts.every((n) => !isNaN(n));
    const [vbX, vbY, vbW, vbH] = hasVb ? vbParts
      : [0, 0, parseFloat(propSvg.getAttribute('width')) || 100, parseFloat(propSvg.getAttribute('height')) || 100];

    const bbox = anchorEl.getBBox();
    const width = bbox.width * scale;
    const height = vbW ? width * (vbH / vbW) : width;
    const px = bbox.x + bbox.width / 2 - width / 2; // bottom-center of prop = top-center of anchor
    const py = bbox.y - height;
    const k = vbW ? width / vbW : 1;

    const ns = 'http://www.w3.org/2000/svg';
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('class', 'worn');
    g.dataset.anchor = anchor;
    g.setAttribute('transform', `translate(${px}, ${py}) scale(${k}) translate(${-vbX}, ${-vbY})`);
    for (const child of [...propSvg.children]) g.appendChild(document.importNode(child, true));

    this.unwear(anchor); // second wear on the same anchor replaces
    anchorEl.parentNode.insertBefore(g, anchorEl.nextSibling);
    this.wornProps.set(anchor, g);
  }

  unwear(anchor) {
    const g = this.wornProps.get(anchor);
    if (g) { g.remove(); this.wornProps.delete(anchor); }
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
      actors: new Map(), // actor id -> { id, what, kind: 'character'|'prop', x, scale, behind, el, puppet }
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
    this.rescaleFrame(f); // rect changed -> frame's pixel height likely changed too
  }

  // Recompute one frame's puppet scale (see Puppet.applyScale) and, if it's
  // holding a face close-up, re-frame it so the shot doesn't drift once the
  // underlying height has changed. Safe to call on a frame with no puppet.
  rescaleFrame(f) {
    if (f.puppet) {
      f.puppet.applyScale();
      if (f.puppet.view === 'face') f.puppet.setView('face', true);
    }
    for (const a of f.actors.values()) {
      if (a.puppet) {
        a.puppet.applyScale();
        if (a.puppet.view === 'face') a.puppet.setView('face', true);
      } else if (a.kind === 'prop') {
        this.applyPropScale(f, a);
      }
    }
  }

  rescaleAll() {
    for (const f of this.frames.values()) this.rescaleFrame(f);
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
    for (const a of f.actors.values()) if (a.puppet) a.puppet.stopSpeaking();
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

    for (const f of this.frames.values()) {
      if (f.puppet) f.puppet.stopSpeaking();
      for (const a of f.actors.values()) if (a.puppet) a.puppet.stopSpeaking();
      f.el.remove();
    }
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

  // ------------------------------------------------------------- actors
  //
  // An actor is a placed entity in a frame in addition to its primary
  // character: either a character instance (a full Puppet bound to its own
  // DOM subtree, sibling to the primary's) or a prop instance (a plain
  // positioned element holding the resolved asset). Both stand on the same
  // floor line as the primary, positioned by x% (center-anchored), sized by
  // scale. z-order: appended after the primary (in front) unless `behind`.

  place(cue) {
    const frameId = cue.frame || this.activeId;
    if (cue.frame) this.activeId = frameId;
    this.placeActor(this.ensureFrame(frameId), cue);
  }

  async placeActor(f, cue) {
    const id = cue.id || cue.what;
    const existing = f.actors.get(id);
    const x = cue.x !== undefined && !isNaN(cue.x) ? cue.x : undefined;

    if (existing && existing.what === cue.what) {
      // Same id + same `what`: update in place (x/scale glide via transition).
      if (x !== undefined) {
        existing.x = x;
        if (existing.kind === 'character' && existing.puppet) existing.puppet.setX(x, 600);
        else this.moveActor(existing, x);
      }
      if (cue.scale !== undefined) {
        existing.scale = cue.scale;
        if (existing.kind === 'character' && existing.puppet) {
          const svg = existing.puppet.svg;
          existing.puppet.actorScale = cue.scale;
          if (svg) { svg.style.transition = 'height 600ms ease'; existing.puppet.applyScale(); }
        } else {
          this.scaleActor(existing, cue.scale);
        }
      }
      if (cue.behind !== undefined && cue.behind !== existing.behind) {
        existing.behind = cue.behind;
        this.insertActorEl(f, existing);
      }
      return;
    }
    if (existing) this.destroyActor(f, existing); // different `what` at the same id: replace

    const isCharacter = await this.probeCharacter(cue.what);
    const actor = {
      id, what: cue.what, kind: isCharacter ? 'character' : 'prop',
      x: x !== undefined ? x : 50,
      scale: cue.scale !== undefined ? cue.scale : (isCharacter ? 1 : 0.4),
      behind: !!cue.behind,
      frameId: f.id, el: null, puppet: null,
    };
    f.actors.set(id, actor);

    if (actor.kind === 'character') {
      const wrap = document.createElement('div');
      wrap.className = 'frame-actor';
      wrap.dataset.id = id;
      wrap.innerHTML = '<div class="frame-camera"><div class="frame-pos"><div class="frame-flip"></div></div></div>';
      actor.el = wrap;
      this.insertActorEl(f, actor);
      const puppet = new Puppet(wrap);
      puppet.actorScale = actor.scale;
      actor.puppet = puppet;
      await puppet.load(cue.what);
      puppet.setX(actor.x, 0);
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'prop-actor';
      wrap.dataset.id = id;
      actor.el = wrap;
      this.insertActorEl(f, actor);
      wrap.style.left = actor.x + '%';
      this.applyPropScale(f, actor);
      await this.loadPropAsset(actor, cue.what);
    }
  }

  // Resolves whether `what` names a character (a rig, direction-capable) or
  // a prop asset, the same way loading a character into a frame does —
  // fetch its manifest and see if the server (or the dbbasic shim) has it.
  async probeCharacter(what) {
    try {
      const r = await fetch(`/characters/${what}/manifest.json`);
      return r.ok;
    } catch { return false; }
  }

  insertActorEl(f, actor) {
    const primaryCam = f.el.querySelector(':scope > .frame-camera');
    if (actor.behind && primaryCam) f.el.insertBefore(actor.el, primaryCam);
    else f.el.appendChild(actor.el);
  }

  applyPropScale(f, actor) {
    const frameH = f.el.clientHeight || 720;
    const h = Math.max(20, PROP_DESIGN_HEIGHT * actor.scale * (frameH / 720));
    actor.el.style.height = h + 'px';
  }

  async loadPropAsset(actor, propId) {
    try {
      const res = await fetch(assetUrl('props', propId));
      if (!res.ok) throw new Error('missing asset');
      const ctype = res.headers.get('content-type') || '';
      if (ctype.includes('svg')) {
        actor.el.innerHTML = await res.text();
      } else {
        const img = document.createElement('img');
        img.src = res.url;
        actor.el.appendChild(img);
      }
    } catch {
      toast(`place: missing prop asset "${propId}"`);
      // Leave a visible placeholder so the id/scale/x is still legible on
      // stage instead of silently rendering nothing.
      actor.el.style.background = 'rgba(255,255,255,.12)';
      actor.el.style.border = '1px dashed rgba(255,255,255,.4)';
      actor.el.style.minWidth = '0.6em';
    }
  }

  removeActor(cue) {
    const target = cue.frame ? this.frames.get(cue.frame) : null;
    let f = target, actor = f && f.actors.get(cue.id);
    if (!actor) { // no explicit frame, or not found there: search every frame
      for (const cand of this.frames.values()) {
        if (cand.actors.has(cue.id)) { f = cand; actor = cand.actors.get(cue.id); break; }
      }
    }
    if (!actor) return;
    this.destroyActor(f, actor);
  }

  destroyActor(f, actor) {
    if (actor.puppet) actor.puppet.stopSpeaking();
    actor.el.remove();
    f.actors.delete(actor.id);
  }

  // ------------------------------------------------------- full-stage reset
  //
  // Shared by the `script-start` cue (a new script is about to run) and the
  // `[clear]` mid-script direction: wipes everything a script builds up on
  // top of a frame — placed actors and their speech, worn props, content
  // tiles, and overlays — so a re-run (or a mid-show reset) starts from a
  // clean stage. Deliberately leaves music (it survives script-start by
  // spec), captions on/off state, backgrounds, and the frame layout itself
  // untouched — those aren't "things a script builds up", they're ambient
  // stage state.
  clearAll() {
    for (const f of this.frames.values()) {
      if (f.puppet) {
        for (const anchor of [...f.puppet.wornProps.keys()]) f.puppet.unwear(anchor);
        f.puppet.stopSpeaking();
      }
      for (const actor of [...f.actors.values()]) {
        if (actor.puppet) for (const anchor of [...actor.puppet.wornProps.keys()]) actor.puppet.unwear(anchor);
        this.destroyActor(f, actor); // stops actor speech + removes its DOM
      }
      f.contentEl.innerHTML = '';
    }
    this.overlayClear();
  }

  // Resolves the actor named by cue.actor, scoped to cue.frame (or the
  // active frame) first; if no frame was explicitly given, falls back to a
  // search across every frame (actor ids are typically unique stage-wide).
  resolveActor(cue) {
    const frameId = cue.frame || this.activeId;
    if (cue.frame) this.activeId = frameId;
    const f = this.frames.get(frameId);
    let actor = f && f.actors.get(cue.actor);
    if (!actor && !cue.frame) {
      for (const cand of this.frames.values()) {
        if (cand.actors.has(cue.actor)) { actor = cand.actors.get(cue.actor); break; }
      }
    }
    return actor;
  }

  // ---------------------------------------------------- prop directions
  //
  // [<id> move N] / [<id> scale N] / [<id> spin] / [<id> bounce] — only
  // meaningful for prop actors (character actors take the full walk/action
  // direction set through their own Puppet instead).

  moveActor(actor, x, instant) {
    if (actor.kind !== 'prop') return;
    actor.x = x;
    actor.el.style.transition = instant ? 'none' : 'left 600ms ease';
    actor.el.style.left = x + '%';
  }

  scaleActor(actor, scale, instant) {
    if (actor.kind !== 'prop') return;
    actor.scale = scale;
    actor.el.style.transition = instant ? 'none' : 'height 600ms ease';
    const f = this.frames.get(actor.frameId);
    if (f) this.applyPropScale(f, actor);
  }

  spinActor(actor) {
    if (actor.kind !== 'prop') return;
    actor.el.style.transformOrigin = '50% 100%';
    actor.el.animate(
      [{ transform: 'translateX(-50%) rotate(0deg)' }, { transform: 'translateX(-50%) rotate(360deg)' }],
      { duration: 700, easing: 'ease-in-out' });
  }

  bounceActor(actor) {
    if (actor.kind !== 'prop') return;
    actor.el.style.transformOrigin = '50% 100%';
    actor.el.animate([
      { transform: 'translateX(-50%) translateY(0) scale(1,1)' },
      { transform: 'translateX(-50%) translateY(0) scale(1.15,0.85)', offset: 0.15 },
      { transform: 'translateX(-50%) translateY(-30px) scale(0.9,1.15)', offset: 0.5 },
      { transform: 'translateX(-50%) translateY(0) scale(1.15,0.85)', offset: 0.85 },
      { transform: 'translateX(-50%) translateY(0) scale(1,1)' },
    ], { duration: 500, easing: 'ease-in-out' });
  }

  // ----------------------------------------------------------- wearables

  // `target` is a frame id (its primary character) or an actor id; frame
  // ids resolve first, matching every other target-resolution rule here.
  resolveWearTarget(targetId) {
    const f = this.frames.get(targetId);
    if (f && f.puppet) return f.puppet;
    for (const cand of this.frames.values()) {
      const a = cand.actors.get(targetId);
      if (a && a.puppet) return a.puppet;
    }
    return null;
  }

  wear(cue) {
    const puppet = this.resolveWearTarget(cue.target);
    if (!puppet) { toast(`wear: unknown target "${cue.target}"`); return; }
    puppet.wear(cue.anchor || 'head', cue.prop, cue.scale !== undefined ? cue.scale : 1);
  }

  unwear(cue) {
    const puppet = this.resolveWearTarget(cue.target);
    if (!puppet) return;
    puppet.unwear(cue.anchor || 'head');
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

// ------------------------------------------------------------- MusicEngine
//
// Stage-global background music + one-shot SFX, driven by small JSON note
// patterns (assets/music/*.json, assets/sfx/*.json — see docs/design/
// actors-wearables-music.md) rather than audio files. One instance for the
// whole stage (not per-frame): music survives frame/layout changes and
// script-start; only an explicit `[music off]` stops it. The instance is
// created lazily on the first `music`/`sfx` cue (see ensureMusicEngine
// below), so a script that never uses either never constructs an
// AudioContext or makes a sound — same backward-compatibility contract as
// every other additive feature here.
//
// Scheduling is the standard Web Audio "lookahead" pattern: a ~100ms timer
// looks ~300ms into ctx.currentTime and schedules any notes that fall due in
// that window with their exact absolute start time (rather than one
// setTimeout per note, which drifts). Each note is an OscillatorNode of the
// track's wave through its own short-envelope GainNode (~10ms linear attack,
// ~50ms linear release) so notes don't click. `loop:true` patterns are
// scheduled by wall-clock offset from an absolute pattern-start time modulo
// the pattern's total beat length, so they repeat seamlessly.
//
// Two gain stages, deliberately kept separate:
//   - a per-player "layer" gain (crossfade control) — a new music cue ramps
//     a fresh player's layer in from 0 while the old player's layer ramps
//     out, both over ~300ms, then the old player is torn down.
//   - the shared `musicMaster` gain (ducking control) that every music
//     layer feeds into on its way to the destination, base ~0.5, ramped to
//     40% of base while any speech clip is playing anywhere on the stage
//     (see Puppet.speak/stopSpeaking's musicEngine.duck()/unduck() calls)
//     and back once nothing is speaking.
// SFX are one-shots: their own player connects straight to ctx.destination,
// bypassing musicMaster entirely, so they're never ducked and never
// crossfaded — they just play once over whatever else is happening.

const MUSIC_LOOKAHEAD_MS = 100;   // scheduler tick interval
const MUSIC_SCHEDULE_AHEAD = 0.3; // seconds of lookahead scheduled per tick
const MUSIC_BASE_GAIN = 0.5;
const MUSIC_DUCK_FACTOR = 0.4;    // fraction of base gain while speech plays
const MUSIC_DUCK_MS = 150;
const MUSIC_CROSSFADE_MS = 300;
const NOTE_ATTACK = 0.01;
const NOTE_RELEASE = 0.05;

function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

// One playing instance of a note pattern (either the current music track, an
// outgoing music track mid-crossfade, or a single SFX one-shot). Owns its own
// lookahead scheduler and layer GainNode; `output` is where that layer feeds
// (musicMaster for music, ctx.destination directly for sfx).
class PatternPlayer {
  constructor(ctx, pattern, output) {
    this.ctx = ctx;
    this.loop = !!pattern.loop;
    this.secPerBeat = 60 / (pattern.tempo || 120);
    this.notes = [];
    for (const track of pattern.tracks || []) {
      const wave = track.wave || 'sine';
      const gain = track.gain !== undefined ? track.gain : 0.2;
      for (const [beat, midi, len] of track.notes || []) {
        this.notes.push({ beat, midi, len, wave, gain });
      }
    }
    this.notes.sort((a, b) => a.beat - b.beat);
    this.patternBeats = this.notes.reduce((m, n) => Math.max(m, n.beat + n.len), 0) || 1;

    this.layerGain = ctx.createGain();
    this.layerGain.gain.value = 1;
    this.layerGain.connect(output);

    this.loopStart = null;
    this.nextIdx = 0;
    this.timer = null;
    this.stopped = false;
  }

  start(fadeInMs) {
    const now = this.ctx.currentTime;
    this.loopStart = now + 0.05; // small safety margin so the first note never lands in the past
    this.nextIdx = 0;
    if (fadeInMs) {
      this.layerGain.gain.setValueAtTime(0, now);
      this.layerGain.gain.linearRampToValueAtTime(1, now + fadeInMs / 1000);
    } else {
      this.layerGain.gain.setValueAtTime(1, now);
    }
    this.schedule(); // cover the first window immediately; no gap before the timer's first tick
    this.timer = setInterval(() => this.schedule(), MUSIC_LOOKAHEAD_MS);
  }

  schedule() {
    if (this.stopped) return;
    const aheadUntil = this.ctx.currentTime + MUSIC_SCHEDULE_AHEAD;
    const loopSeconds = this.patternBeats * this.secPerBeat;
    for (;;) {
      if (this.nextIdx >= this.notes.length) {
        if (!this.loop) {
          if (this.ctx.currentTime > this.loopStart + loopSeconds) this.stop();
          return;
        }
        this.loopStart += loopSeconds;
        this.nextIdx = 0;
        continue;
      }
      const note = this.notes[this.nextIdx];
      const t = this.loopStart + note.beat * this.secPerBeat;
      if (t > aheadUntil) return;
      this.playNote(note, t);
      this.nextIdx++;
    }
  }

  playNote(note, t) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = note.wave;
    osc.frequency.setValueAtTime(midiToFreq(note.midi), t);
    const g = ctx.createGain();
    const dur = Math.max(note.len * this.secPerBeat, NOTE_ATTACK + NOTE_RELEASE);
    const releaseStart = Math.max(t + NOTE_ATTACK, t + dur - NOTE_RELEASE);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(note.gain, t + NOTE_ATTACK);
    g.gain.setValueAtTime(note.gain, releaseStart);
    g.gain.linearRampToValueAtTime(0, releaseStart + NOTE_RELEASE);
    osc.connect(g);
    g.connect(this.layerGain);
    osc.start(t);
    osc.stop(releaseStart + NOTE_RELEASE + 0.02);
  }

  fadeOutAndStop(ms) {
    const now = this.ctx.currentTime;
    this.layerGain.gain.cancelScheduledValues(now);
    this.layerGain.gain.setValueAtTime(this.layerGain.gain.value, now);
    this.layerGain.gain.linearRampToValueAtTime(0, now + ms / 1000);
    setTimeout(() => this.stop(), ms + 20);
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    try { this.layerGain.disconnect(); } catch { /* already disconnected */ }
  }
}

class MusicEngine {
  constructor() {
    this.ctx = null;
    this.musicMaster = null;
    this.player = null;        // currently-current music PatternPlayer (an outgoing one during crossfade keeps its own timer alive independently)
    this.currentId = null;
    this.cache = new Map();    // "kind/id" -> parsed JSON, or null for a confirmed-missing asset
    this.pending = new Map();  // "kind/id" -> in-flight fetch promise
    this.pendingMusicId = null; // desired track id requested before the AudioContext was running; started on unlock
    this.musicGen = 0;         // bumped on every music()/stopMusic() call so a stale in-flight fetch can't clobber a newer request
    this.duckCount = 0;
  }

  ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.musicMaster = this.ctx.createGain();
      this.musicMaster.gain.value = MUSIC_BASE_GAIN;
      this.musicMaster.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  async fetchPattern(kind, id) {
    const key = `${kind}/${id}`;
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.pending.has(key)) return this.pending.get(key);
    const p = (async () => {
      try {
        const res = await fetch(assetUrl(kind, id));
        if (!res.ok) throw new Error('missing asset');
        return await res.json();
      } catch {
        return null;
      }
    })();
    this.pending.set(key, p);
    const result = await p;
    this.pending.delete(key);
    this.cache.set(key, result);
    return result;
  }

  // -------------------------------------------------------------- music

  async music(cue) {
    const gen = ++this.musicGen;
    if (cue.off) { this.stopMusic(); return; }
    if (!cue.id) return;
    const ctx = this.ensureCtx();
    if (ctx.state !== 'running') {
      ctx.resume().catch(() => {});
      this.pendingMusicId = cue.id;
      toast('🔇 Click anywhere once to enable sound');
      return;
    }
    await this.startMusic(cue.id, gen);
  }

  async startMusic(id, gen) {
    const pattern = await this.fetchPattern('music', id);
    if (gen !== this.musicGen) return; // superseded by a newer [music ...]/[music off] while fetching
    if (!pattern) { toast(`music: missing track "${id}"`); return; }
    const old = this.player;
    const fresh = new PatternPlayer(this.ctx, pattern, this.musicMaster);
    this.player = fresh;
    this.currentId = id;
    fresh.start(MUSIC_CROSSFADE_MS);
    if (old) old.fadeOutAndStop(MUSIC_CROSSFADE_MS);
  }

  stopMusic() {
    this.musicGen++;
    this.pendingMusicId = null;
    if (this.player) { this.player.fadeOutAndStop(MUSIC_CROSSFADE_MS); this.player = null; }
    this.currentId = null;
  }

  // ---------------------------------------------------------------- sfx

  async sfx(cue) {
    if (!cue.id) return;
    const ctx = this.ensureCtx();
    if (ctx.state !== 'running') {
      await ctx.resume().catch(() => {});
      if (ctx.state !== 'running') { toast('🔇 Click anywhere once to enable sound'); return; }
    }
    const pattern = await this.fetchPattern('sfx', cue.id);
    if (!pattern) { toast(`sfx: missing "${cue.id}"`); return; }
    new PatternPlayer(ctx, { ...pattern, loop: false }, ctx.destination).start(0);
  }

  // ------------------------------------------------------------- ducking
  //
  // A simple concurrent-speakers counter: Puppet.speak()/stopSpeaking() call
  // duck()/unduck() once per clip (across every frame/actor puppet), so
  // overlapping speech from more than one character still only ramps at the
  // 0->1 and 1->0 transitions.

  duck() {
    this.duckCount++;
    if (this.duckCount === 1 && this.musicMaster) this.rampMaster(MUSIC_BASE_GAIN * MUSIC_DUCK_FACTOR);
  }

  unduck() {
    this.duckCount = Math.max(0, this.duckCount - 1);
    if (this.duckCount === 0 && this.musicMaster) this.rampMaster(MUSIC_BASE_GAIN);
  }

  rampMaster(target) {
    const now = this.ctx.currentTime;
    this.musicMaster.gain.cancelScheduledValues(now);
    this.musicMaster.gain.setValueAtTime(this.musicMaster.gain.value, now);
    this.musicMaster.gain.linearRampToValueAtTime(target, now + MUSIC_DUCK_MS / 1000);
  }

  // Called from the shared gesture-unlock listener alongside every puppet's
  // own unlock (mirrors Puppet's suspended-context handling): if a [music]
  // cue arrived before any gesture, this is where its track actually starts.
  unlock() {
    if (!this.ctx) return;
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    if (this.pendingMusicId) {
      const id = this.pendingMusicId;
      this.pendingMusicId = null;
      this.startMusic(id, ++this.musicGen);
    }
  }
}

// ------------------------------------------------------------- cue bus

const $id = (i) => document.getElementById(i);

const stage = new Stage($id('frames'), $id('overlays'), $id('captions'), $id('take'));
stage.ensureFrame('main'); // boots as one full-size frame + the default character

// Stage-global MusicEngine, constructed lazily on the first music/sfx cue —
// a script that never uses either never allocates it (or its AudioContext).
let musicEngine = null;
function ensureMusicEngine() { return musicEngine || (musicEngine = new MusicEngine()); }

function mainPuppet() {
  const f = stage.frames.get('main');
  return f && f.puppet;
}

// Character direction (speak/action/walk/look/view) targets an actor's
// Puppet when the cue carries `actor`, else the frame's primary — same
// resolution order the parser applies (frame id, then actor id).
function puppetForCue(cue) {
  if (cue.actor) {
    const a = stage.resolveActor(cue);
    return a ? a.puppet : null;
  }
  return stage.forFrame(cue);
}

function handleCue(cue) {
  switch (cue.type) {
    case 'frame': {
      const f = stage.frame(cue);
      if (cue.character) loadCharacter(cue.character, f.id, { view: cue.view, facing: cue.facing });
      syncFrameTargets();
      break;
    }
    case 'frame-clear': stage.frameClear(cue); syncFrameTargets(); break;
    case 'layout': stage.layout(cue); syncFrameTargets(); break;
    case 'content': stage.content(cue); break;
    case 'content-clear': stage.contentClear(cue); break;
    case 'scene': stage.scene(cue); break;
    case 'place': stage.place(cue); break;
    case 'remove': stage.removeActor(cue); break;
    case 'move': { const a = stage.resolveActor(cue); if (a) stage.moveActor(a, cue.x); break; }
    case 'scale': { const a = stage.resolveActor(cue); if (a) stage.scaleActor(a, cue.value); break; }
    case 'spin': { const a = stage.resolveActor(cue); if (a) stage.spinActor(a); break; }
    case 'bounce': { const a = stage.resolveActor(cue); if (a) stage.bounceActor(a); break; }
    case 'wear': stage.wear(cue); break;
    case 'unwear': stage.unwear(cue); break;
    case 'music': ensureMusicEngine().music(cue); break;
    case 'sfx': ensureMusicEngine().sfx(cue); break;
    case 'overlay': stage.overlay(cue); break;
    case 'overlay-clear': stage.overlayClear(cue); break;
    case 'captions': stage.captions(cue); break;
    case 'transition': stage.transition(cue); break;
    case 'speak': {
      const p = puppetForCue(cue);
      if (p) p.speak(cue);
      stage.showCaption(cue);
      break;
    }
    case 'action': { const p = puppetForCue(cue); if (p) p.act(cue.name); break; }
    case 'walk': { const p = puppetForCue(cue); if (p) p.walkTo(cue.x, cue.jump || cue.from); break; }
    case 'look': { const p = puppetForCue(cue); if (p) p.look(cue.dir); break; }
    case 'view': { const p = puppetForCue(cue); if (p) p.setView(cue.mode); break; }
    case 'character': {
      const id = cue.frame || stage.activeId;
      if (cue.frame) stage.activeId = id;
      loadCharacter(cue.name, id);
      break;
    }
    case 'script-start':
      stage.clearAll();
      prompterStart(cue.lines);
      break;
    case 'script-line': prompterHighlight(cue.index); break;
    case 'script-end': prompterEnd(); break;
    case 'clear': stage.clearAll(); break;
    case 'error': toast(cue.message); break;
  }
}

const events = new EventSource('/api/events');
events.onmessage = (e) => handleCue(JSON.parse(e.data));

// surface runtime errors on the stage itself — invaluable when a cue breaks
window.addEventListener('error', (e) => toast(`js error: ${e.message}`));
window.addEventListener('unhandledrejection', (e) =>
  toast(`js error: ${(e.reason && e.reason.message) || e.reason}`));

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
    for (const f of stage.frames.values()) {
      if (f.puppet) unlockAudio(f.puppet);
      for (const a of f.actors.values()) if (a.puppet) unlockAudio(a.puppet);
    }
    if (musicEngine) musicEngine.unlock();
  }, true);
}

// Puppet height is proportional to its frame's height (see
// Puppet.applyScale), so a browser resize can change every frame's pixel
// size at once even though no rect ever changed. Lightly debounced since
// 'resize' can fire in a burst while the window is being dragged.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => stage.rescaleAll(), 100);
});

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
// With one frame the panel targets it exactly as the single-puppet stage
// did before frames existed. Once a screenplay (or the layout buttons)
// splits the stage into more than one frame, a chip row (#frame-target)
// lets the user pick which frame every panel-originated cue targets;
// `targetFrame` is the source of truth and defaults to 'main'.

let targetFrame = 'main';

// -------------------------------------------------------------- record mode
//
// When active, every PANEL-initiated action (not incoming SSE cues, and
// never Run/Stop/Load) appends its screenplay-grammar equivalent to the
// #script textarea, so a user can drive the puppet by hand and end up with a
// runnable script. `chipsVisible()` mirrors the same single/multi-frame
// branch every other panel control already uses to decide whether to target
// `targetFrame` explicitly.

let recording = false;

function chipsVisible() {
  return $id('frame-target').style.display !== 'none';
}

function record(line) {
  if (!recording) return;
  const ta = $id('script');
  ta.value = ta.value ? ta.value + '\n' + line : line;
  ta.scrollTop = ta.scrollHeight;
}

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
    frame: targetFrame,
  });
  record(chipsVisible() ? `${targetFrame}: ${text}` : text);
});

$id('engine').addEventListener('change', (e) => {
  loadVoices();
  record(`[engine ${e.target.value}]`);
});
$id('voice').addEventListener('change', (e) => {
  record(`[voice ${e.target.value}]`);
});

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

function targetPuppet() {
  const f = stage.frames.get(targetFrame);
  return f && f.puppet;
}

function buildActionButtons() {
  const box = $id('actions');
  box.innerHTML = '';
  const p = targetPuppet();
  for (const name of Object.keys((p && p.manifest || {}).actions || {})) {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => {
      post('/api/cue', { type: 'action', name, frame: targetFrame });
      record(chipsVisible() ? `[${targetFrame} ${name}]` : `[${name}]`);
    };
    box.appendChild(b);
  }
  for (const dir of ['left', 'front', 'right']) {
    const b = document.createElement('button');
    b.textContent = `look ${dir}`;
    b.onclick = () => {
      post('/api/cue', { type: 'look', dir, frame: targetFrame });
      record(chipsVisible() ? `[${targetFrame} look ${dir}]` : `[look ${dir}]`);
    };
    box.appendChild(b);
  }
  for (const mode of ['face', 'body']) {
    const b = document.createElement('button');
    b.textContent = `🎥 ${mode}`;
    b.onclick = () => {
      post('/api/cue', { type: 'view', mode, frame: targetFrame });
      record(chipsVisible() ? `[${targetFrame} view ${mode}]` : `[view ${mode}]`);
    };
    box.appendChild(b);
  }
}

$id('walk').addEventListener('change', (e) => {
  const x = parseInt(e.target.value, 10);
  post('/api/cue', { type: 'walk', x, frame: targetFrame });
  record(chipsVisible() ? `[${targetFrame} walk ${x}]` : `[walk to ${x}]`);
});

// -------------------------------------------------------------- scene

for (const btn of document.querySelectorAll('#layout-buttons button')) {
  btn.onclick = () => {
    post('/api/cue', { type: 'layout', preset: btn.dataset.preset });
    record(`[layout ${btn.dataset.preset}]`);
  };
}

$id('scene-bg').addEventListener('change', (e) => {
  const bg = e.target.value;
  if (!bg) return;
  post('/api/cue', { type: 'scene', bg }); // targets the active frame server-side
  record(chipsVisible() ? `[${targetFrame} scene ${bg}]` : `[scene ${bg}]`);
  e.target.value = ''; // picker, not a state display
});

let captionsOn = false;
$id('captions-toggle').onclick = (e) => {
  captionsOn = !captionsOn;
  post('/api/cue', { type: 'captions', on: captionsOn });
  e.target.textContent = captionsOn ? 'CC on' : 'CC off';
  e.target.classList.toggle('on', captionsOn);
  record(captionsOn ? '[captions on]' : '[captions off]');
};

for (const btn of document.querySelectorAll('[data-transition-name]')) {
  btn.onclick = () => {
    post('/api/cue', {
      type: 'transition', name: btn.dataset.transitionName, dir: btn.dataset.transitionDir,
    });
    record(`[${btn.dataset.transitionName} ${btn.dataset.transitionDir}]`);
  };
}

async function loadAssets() {
  try {
    const { backgrounds, music, sfx } = await (await fetch('/api/assets')).json();
    const sel = $id('scene-bg');
    if (!backgrounds || !backgrounds.length) { sel.style.display = 'none'; }
    for (const id of backgrounds || []) {
      const o = document.createElement('option');
      o.value = o.textContent = id;
      sel.appendChild(o);
    }

    const musicSection = $id('music-section');
    if ((!music || !music.length) && (!sfx || !sfx.length)) { musicSection.style.display = 'none'; return; }
    musicSection.style.display = '';

    const musicSel = $id('music-select');
    for (const id of music || []) {
      const o = document.createElement('option');
      o.value = o.textContent = id;
      musicSel.appendChild(o);
    }

    const sfxBox = $id('sfx-buttons');
    for (const id of sfx || []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `🔔 ${id}`;
      b.onclick = () => {
        post('/api/cue', { type: 'sfx', id });
        record(`[sfx ${id}]`);
      };
      sfxBox.appendChild(b);
    }
  } catch { /* asset list is a nicety */ }
}

$id('music-select').addEventListener('change', (e) => {
  const id = e.target.value;
  if (!id) return;
  post('/api/cue', { type: 'music', id });
  record(`[music ${id}]`);
  e.target.value = ''; // picker, not a state display
});

$id('music-off').onclick = () => {
  post('/api/cue', { type: 'music', off: true });
  record('[music off]');
};

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

$id('record-toggle').onclick = (e) => {
  recording = !recording;
  e.target.textContent = recording ? '● Recording' : '● Record';
  e.target.classList.toggle('rec-on', recording);
};

// Applies a puppet's manifest-declared voice preference (engine + voice) to
// the engine/voice selects, refreshing the voice list in between so the
// preferred voice is actually a valid option by the time it's set. Shared
// between loadCharacter and the frame-target chip click handler.
async function applyVoicePref(puppet) {
  const pref = puppet && puppet.manifest && puppet.manifest.voice;
  if (!pref) return;
  if (pref.engine) $id('engine').value = pref.engine;
  await loadVoices();
  if (pref.voice) $id('voice').value = pref.voice;
}

async function loadCharacter(name, frameId = 'main', extra = {}) {
  const f = stage.ensureFrame(frameId);
  await stage.loadCharacterInto(f, name);
  if (extra.view) f.puppet.setView(extra.view, true);
  if (extra.facing !== undefined) f.puppet.face(extra.facing);
  if (frameId !== targetFrame) return;

  buildActionButtons();
  const sel = $id('character');
  if (sel.value !== name) sel.value = name;
  await applyVoicePref(f.puppet);
}

$id('character').addEventListener('change', (e) => {
  post('/api/cue', { type: 'character', name: e.target.value, frame: targetFrame });
  record(`[frame ${targetFrame} character:${e.target.value}]`);
});

// -------------------------------------------------------- frame targeting
//
// Only shown once a screenplay (or the layout buttons) creates more than
// one frame; with a single frame it stays hidden and targetFrame tracks
// that lone frame's id, exactly like the pre-frames single-puppet stage.

function syncFrameTargets() {
  const row = $id('frame-target');
  const ids = [...stage.frames.keys()];
  if (!stage.frames.has(targetFrame)) {
    targetFrame = stage.frames.has(stage.activeId) ? stage.activeId : (ids[0] || 'main');
  }
  if (ids.length <= 1) {
    targetFrame = ids[0] || 'main';
    row.style.display = 'none';
    row.innerHTML = '';
    return;
  }
  row.style.display = '';
  row.innerHTML = '';
  for (const id of ids) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = id;
    if (id === targetFrame) b.classList.add('sel');
    b.onclick = () => selectTargetFrame(id);
    row.appendChild(b);
  }
}

async function selectTargetFrame(id) {
  targetFrame = id;
  syncFrameTargets();
  const f = stage.frames.get(id);
  const p = f && f.puppet;
  const sel = $id('character');
  sel.value = (p && p.characterName) || ''; // silent: no change event dispatched
  buildActionButtons();
  await applyVoicePref(p);
}

// ---------------------------------------------------------------- boot

(async function init() {
  syncFrameTargets(); // boots as one frame ('main'): chip row starts hidden
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
