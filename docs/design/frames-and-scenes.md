# Frames, scenes, and overlays

Design spec for turning the single-character stage into a small compositor:
multiple independent framed regions, per-frame backgrounds and characters,
content-only tiles (text / image / video), and overlays (lower-thirds). All
scriptable from the screenplay language, all driven by the existing cue bus.

This is the load-bearing schema. Everything downstream — news kits, cartoon
kits, asset packs, AI-authored shows — sits on the primitives defined here.

## The core idea: the frame

Today the stage is one region with one camera and one character. A **frame**
generalizes that into an independent rectangular sub-stage. The screen holds
one or more frames; each frame has its own:

- **background** — an asset (image/SVG) or a solid/gradient fill
- **content** (optional) — text, image, or video, for tiles with no character
- **character** (optional) — a loaded character with its own position/facing
- **camera** — its own `face` / `body` view, reusing the existing camera work

A single talking head is just one frame at full size (the default). Two heads
framed separately with different backgrounds are two frames side by side, each
camera locked to `face`. The news two-box, the interview, the shot/reverse —
all the same primitive.

### Backward compatibility (hard requirement)

If no `frame` cue is ever sent, the stage behaves **exactly as it does today**:
one implicit frame `main` at full size holding the default character. Every
existing cue (`speak`, `action`, `walk`, `look`, `view`, `character`) and the
existing control panel target `main`. No existing screenplay, API call, or UI
control may change behavior. The frame system is strictly additive.

## Layers (z-order, back to front)

```
┌─ #stage ─────────────────────────────────────────┐
│  #frames        one or more .frame regions        │
│    each .frame:  bg → content → character+camera   │
│  #overlays      lower-thirds, cards (above frames) │
│  #prompter      teleprompter (existing)            │
│  #toast         (existing)                         │
└───────────────────────────────────────────────────┘
```

Overlays live above all frames because a lower-third or card spans the whole
broadcast, not one frame.

## Frame geometry: slots and rects

A frame is placed by a named **slot** (scripting convenience) or an explicit
**rect** in stage-percent (power/AI use). Slots resolve to rects:

| slot      | rect (x,y,w,h in %)   | use                          |
|-----------|-----------------------|------------------------------|
| `full`    | 0, 0, 100, 100        | default single view          |
| `left`    | 0, 0, 50, 100         | two-box left                 |
| `right`   | 50, 0, 50, 100        | two-box right                |
| `third-l` | 0, 0, 33.34, 100      | three across                 |
| `third-c` | 33.33, 0, 33.34, 100  |                              |
| `third-r` | 66.66, 0, 33.34, 100  |                              |
| `pip-tr`  | 66, 4, 30, 30         | picture-in-picture, top-right |
| `pip-tl`  | 4, 4, 30, 30          |                              |
| `pip-br`  | 66, 66, 30, 30        |                              |
| `pip-bl`  | 4, 66, 30, 30         |                              |

`rect: [x,y,w,h]` overrides `slot`. Frames render in insertion order; a later
frame (e.g. a pip) draws over an earlier one.

## Cue schema

Every cue is JSON on the existing bus. New and extended types:

### Frame management
```jsonc
{ "type": "frame", "id": "left",        // create or update a frame
  "slot": "left",                        // or "rect": [x,y,w,h]
  "bg": "room",                          // background asset id, "#rrggbb", or omit
  "character": "ava",                    // load this character into the frame (optional)
  "view": "face",                        // "face" | "body" (optional, default body)
  "facing": 1 }                          // 1 right, -1 left (optional)

{ "type": "frame-clear", "id": "left" }  // remove a frame (never remove the last one)
{ "type": "layout", "preset": "split" }  // macro: see Layout presets below
```

### Content (text / image / video tiles)
```jsonc
{ "type": "content", "frame": "right",   // frame id (optional → active frame)
  "kind": "text",                        // "text" | "image" | "video"
  "value": "BREAKING",                   // text string, or asset id / url
  "fit": "contain" }                     // image/video: "contain" | "cover" (optional)
{ "type": "content-clear", "frame": "right" }
```
A content tile and a character can coexist in a frame (e.g. an over-the-
shoulder image), or a frame can be content-only (no character).

### Scene / background
```jsonc
{ "type": "scene", "frame": "main", "bg": "desk" }  // set a frame's background
```

### Character direction (existing cues + optional `frame`)
```jsonc
{ "type": "speak",  "frame": "left", ... }   // all existing speak fields, plus frame
{ "type": "action", "frame": "left", "name": "wave" }
{ "type": "walk",   "frame": "left", "x": 70 }
{ "type": "look",   "frame": "left", "dir": "front" }
{ "type": "view",   "frame": "left", "mode": "face" }
{ "type": "character", "frame": "left", "name": "bo" }
```
Omitting `frame` targets the **active frame** (default `main`), preserving
today's behavior.

### Overlays (above all frames)
```jsonc
{ "type": "overlay", "template": "lower-third",
  "id": "lt1",                           // optional; needed to clear early
  "slots": { "title": "Ava Reyes", "subtitle": "Host" },
  "hold": 4000,                          // ms visible before auto-exit (omit = persist)
  "enter": "slide", "exit": "slide" }    // transition names (optional)
{ "type": "overlay-clear", "id": "lt1" }
```

## Layout presets

Macros that set up common frame arrangements in one cue. Each clears existing
frames and creates the named ones (preserving the default character where it
makes sense):

- `single` → one `full` frame `main`
- `split` → frames `left` + `right`
- `thirds` → `third-l` + `third-c` + `third-r`
- `pip-tr` (etc.) → `main` full + a `pip` frame in that corner

## Screenplay grammar

The screenplay stays line-based: plain lines are spoken, `[bracketed]` lines
are directions, a `(paren)` prefix fires an action during a spoken line. New
directions and one new prefix:

```text
[layout split]                     # preset arrangement
[frame left character:ava bg:desk view:face]   # create/update a frame
[frame right character:bo bg:sky view:face]
[scene desk]                       # set active frame's background
left: Good evening.                # speaker prefix = frame id → speak in that frame
right: Thanks for having me.
[left wave]                        # direction on a specific frame's character
[right emote happy]
[show image:chart fit:contain]     # content tile in the active frame
[lower-third "Ava Reyes" "Host"]   # overlay
[frame right clear]
[layout single]
```

Rules:
- `[frame <id> key:value ...]` — keys: `slot`, `bg`, `character`, `view`,
  `facing`, `rect` (as `rect:x,y,w,h`). Unknown-slot ids auto-place: first
  gets `left`, second `right`, else `full`.
- `<id>: spoken text` — a leading `word:` where `word` matches a frame id sets
  that line's target frame (and makes it active). A `word:` that is not a frame
  id is treated as normal spoken text (so colons in dialogue still work).
- `[<id> <direction...>]` — if the first token is a frame id, the rest is a
  direction (`wave`, `emote happy`, `view face`, `walk 70`, `look left`)
  applied to that frame.
- `[show <kind>:<value> ...]` — content in the active frame; kinds `text`
  (quote multi-word), `image`, `video`.
- `[lower-third "Title" "Subtitle"]` — overlay shorthand → an `overlay` cue
  with template `lower-third`.
- Bare `[direction]` and `speak` lines with no frame prefix target the active
  frame, so single-character scripts are unchanged.

## Assets

A new top-level `assets/` tree holds non-character assets, served like
`characters/`. Grouped by kind so packs stay reviewable:

```text
assets/
  backgrounds/<id>.svg      # full-frame backdrops (a set, a sky, a room)
  props/<id>.svg            # desk, mug, plant — placed within a scene backdrop
  overlays/<id>.svg         # overlay templates with named text slots
```

**Format-agnostic.** An asset id resolves to the first existing file among a
known extension set — SVG *and* raster — so PNG/JPG/WebP/GIF drop into the
same slots as SVG with no code change (the point: AI can generate rasterized
assets later and they Just Work). Resolution for id `foo` in kind `<kind>`:
try `assets/<kind>/foo.svg`, then `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`.
The server exposes which exists (e.g. `GET /api/asset/<kind>/<id>` → the file,
or an index endpoint); the runtime renders SVG inline (so parts can be
referenced) and raster via `<img>` / CSS `background-image`.

- `bg`: an asset id (`desk`), a `#rrggbb` solid, or a `linear-gradient(...)` /
  path / URL used directly.
- `content` `image`/`video`: an asset id **or** a direct path/URL (raster and
  video are native here already).
- Overlay `template`: must be **SVG or HTML** (needs `data-slot` text slots a
  raster can't provide); backgrounds, props, and content tiles accept either
  raster or vector freely.

Overlay templates are SVG (or HTML) with elements whose `data-slot="title"`
marks a text slot the runtime fills from the cue's `slots` map.

We draw the **starter pack in SVG** (hand-authorable, crisp at any frame size,
parts are animatable). Nothing in the schema assumes SVG — a
`backgrounds/desk.png` is equally valid the day someone generates one.

Characters keep living in `characters/<name>/` unchanged. A character used as a
framed head just loads into a frame with `view: face`.

### Starter pack (rudimentary on purpose)

Ship crude-but-real assets so scripting/AI/demos are unblocked immediately; a
crude asset and a polished one occupy the same slot, so upgrading later is a
file swap with no code change.

- `backgrounds/`: `desk` (news desk + wall), `sky` (flat gradient sky),
  `room` (simple flat interior).
- `props/`: `mug`, `plant`, `monitor` (simple flat shapes).
- `overlays/`: `lower-third` (name + title bar with `data-slot` text).
- `characters/bo/`: a second character in a vintage **rubber-hose / flat**
  style (round head, pie-cut eyes, mitt hands) — proves multi-character and
  the flat-cartoon art direction, and serves as the interview second head.
  Full manifest contract (nine visemes, blink, look, idle, a few actions).

## Implementation notes

- Refactor: the current `Puppet` class becomes per-frame. A new `Stage`
  manager owns a map of frames; each frame owns its DOM subtree
  (`.frame-bg`, `.frame-content`, `.frame-camera > .frame-pos > .frame-flip`)
  and, when it has a character, a `Puppet` bound to that subtree. The existing
  camera/blink/idle/gaze/speech logic moves onto the per-frame Puppet nearly
  unchanged — it already scopes DOM queries to the character's own SVG root.
- The `Stage` boots with one `main` frame (slot `full`) + default character to
  preserve current behavior. `handleCue` routes by `cue.frame` (default the
  active frame). The control panel keeps targeting `main`.
- Keep parsers in sync: the grammar lives in `server.js` (`parseScript` /
  `directionCue`) **and** in `integrations/dbbasic/shim.js`. Update both, then
  re-run `integrations/dbbasic/build.py`.
- Audio playback and viseme scheduling are unchanged; a per-frame Puppet plays
  its own clip. Multiple frames can speak, but sequential is the norm (the
  script runner already paces one line at a time).

## Now implemented: captions and iris/fade takes

Two items from the original out-of-scope list have shipped:

- **Captions** — `{ "type": "captions", "on": true|false }`. Toggles a
  broadcast-style subtitle rendered at the bottom of the stage for each
  spoken line; useful for muted/silent playback. Screenplay: `[captions on]`
  / `[captions off]`.
- **Transitions (iris / fade takes)** — `{ "type": "transition", "name":
  "iris"|"fade", "dir": "out"|"in", "ms": 700 }`. A fullscreen take: the
  vintage circular wipe (`iris`) or a fade to/from black (`fade`). Screenplay:
  `[iris out]`, `[iris in]`, `[fade out]`, `[fade in]`, with an optional
  trailing duration in ms (default 700). Neither is a persistent overlay or a
  scene-change modifier — they're standalone fullscreen cues a script fires
  directly, same as any other direction.

## Out of scope (later, same primitives)

Other transitions (dissolve/wipe/stinger beyond iris/fade), persistent
overlays (bug, ticker), fx packs, audio/music beds, parallax backgrounds, and
full-frame "takes" beyond iris/fade (intro/credits/cards). All are new
templates or a transition modifier on scene/frame changes — none require new
core primitives beyond what is specified here.
