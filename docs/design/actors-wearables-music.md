# Actors, wearables, and music

Design spec for the second core expansion: multiple entities per frame
(placeable props, additional creatures), wearable props anchored to
characters, and data-driven background music. Builds strictly on the frame
model in `frames-and-scenes.md`.

## The gap

A frame holds exactly one character. That blocks: money on a table, a hat on
a head, a dog on stage with its trainer, a hoop for the dog to leap through.
This spec generalizes a frame to hold one **primary character** (unchanged —
camera, panel, speaker default all still bind to it) plus any number of
placed **actors**.

## Actors

An actor is a placed entity in a frame: either a **prop instance** (a plain
SVG/raster asset — movable, scalable, not rigged) or a **character instance**
(a full character rig — walks, emotes, speaks, wears).

### Cues

```jsonc
{ "type": "place", "frame": "main",     // create/update an actor
  "id": "hoop1",                         // default: the asset/character name
  "what": "hoop",                        // prop asset id OR character name
  "x": 70,                               // % of frame width (center anchor)
  "scale": 0.5,                          // relative to a character's normal size
  "behind": false }                      // z: behind the primary character
{ "type": "remove", "id": "hoop1" }
```

Resolution of `what`: if it names a folder in `characters/`, the actor is a
character instance (rig loaded, direction-capable); otherwise it resolves as
a prop asset (`assets/props/<what>.*`).

Actors stand on the same floor line as the primary character (bottom-anchored
at the frame's baseline), positioned by `x` percent, sized by `scale` ×
(frame-proportional character height). Props default to `scale` sized against
the same 720-design rule so a `scale: 0.3` prop reads as knee-high.

### Directing actors

The existing `[<id> <direction>]` and `<id>: line` grammar extends: the head
token resolves first against frame ids (existing behavior), then against
actor ids. Character actors accept the full direction set (`walk`, `emote`,
actions, speaking with their manifest voice + visemes). Prop actors accept:

```text
[hoop1 move 40]        # glide to x=40%
[hoop1 scale 0.8]
[hoop1 spin]           # one 360° rotation
[hoop1 bounce]         # small squash-and-stretch hop
```

### Screenplay grammar

```text
[place hoop at 70 scale:0.5]           # prop actor, id "hoop"
[place rex at 15 scale:0.6]            # character actor (rex is a character)
[place money at 55 id:tip scale:0.2]
[rex walk 60]
rex: Woof!
[rex leap]                              # a character action like any other
[remove tip] [remove hoop]
```

`at N` is required; `id:` optional (defaults to the name — one default-id
instance per name at a time); `scale:` optional (default 1 for characters,
0.4 for props); `behind` optional flag.

## Wearables

Characters may declare **anchors** in their manifest:

```jsonc
"anchors": { "head": "#head", "hand": "#arm-right" }
```

Wear cues pin a prop asset to an anchor:

```jsonc
{ "type": "wear", "target": "right", "prop": "tophat", "anchor": "head" }
{ "type": "unwear", "target": "right", "anchor": "head" }
```

`target` is a frame id (its primary character) or an actor id. Grammar:
`[wear right tophat]`, `[wear rex bowler]`, `[unwear right]` (anchor defaults
to `head`). Placement rule: the prop's bottom-center sits at the top-center
of the anchor element's bbox, width = anchor bbox width × the prop's natural
aspect (tweakable per-wear with `scale:`). The worn group is injected inside
the character's SVG adjacent to the anchor element so it inherits head
bobs/nods automatically. Hat-type assets are authored brim-at-bottom.

If a character has no `anchors`, `head` falls back to `#head` when present.

## Music and SFX

Music assets are **JSON note patterns** (MIDI-in-spirit; no audio files),
played by a small Web Audio sequencer in the stage:

```jsonc
// assets/music/circus.json
{ "tempo": 140, "loop": true,
  "tracks": [
    { "wave": "square",   "gain": 0.12,
      "notes": [[0, 60, 0.5], [0.5, 64, 0.5], [1, 67, 0.5], ...] },   // [beat, midi, lenBeats]
    { "wave": "triangle", "gain": 0.18, "notes": [[0, 36, 1], [1, 43, 1], ...] }
  ] }
```

Runtime: oscillator-per-note with a short attack/release envelope, lookahead
scheduling on the shared AudioContext, master gain ~0.5 under speech. `loop`
repeats seamlessly; a new `music` cue crossfades (~300ms) from the old one.

### Cues and grammar

```jsonc
{ "type": "music", "id": "circus" }      // [music circus]
{ "type": "music", "off": true }         // [music off]
{ "type": "sfx", "id": "tada" }          // [sfx tada]  (one-shot, no loop)
```

SFX use the same JSON format (short, `loop: false`), from `assets/sfx/`.
Pacing: both are instant cues (default sleep path). Music state is
stage-global (not per frame) and survives layout changes; `script-start`
does NOT stop music (a show may set its mood before its first line), but a
`[music off]` in the next script does.

### Starter audio set

`assets/music/`: `circus` (bright galop-style loop), `waltz` (gentle 3/4),
`sneak` (low minor vamp), `fanfare` (short loop). `assets/sfx/`: `tada`,
`boing`, `thud`, `chime`.

## Starter menagerie & goods

- `characters/rex/` — a cartoon dog: quadruped rig in the rubber-hose family.
  Same contract (nine mouths drawn as muzzle/jaw shapes — cartoon dogs talk),
  `anchors: {head: "#head"}`, actions include `sit`, `beg`, and `leap` (a
  forward arc with squash-and-stretch — jumps *through* a hoop placed in its
  path), espeak voice with a high pitch or a terse `say` voice.
- `assets/props/`: `hoop` (ring on a stand), `money` (a small bill stack),
  `coin`, `tophat`, `bowler`, `crown` (hats authored brim-at-bottom for
  wearing), `banner` (blank pennant string).
- `assets/backgrounds/bigtop.svg` — circus tent interior: striped canvas
  walls, a ring edge along the floor.

## Compatibility & invariants

- Zero behavior change for existing scripts: no `place`/`wear`/`music` cue →
  nothing new renders or sounds.
- Primary-character binding (camera, panel chips, `frame:` speak routing) is
  untouched; actors are additive scene population.
- Parser stays mirrored in `server.js` and `integrations/dbbasic/shim.js`.
- Music JSON loads via the same format-agnostic asset path style (`/assets/
  music/<id>.json`); the dbbasic package embeds music/sfx JSON like it embeds
  characters (small), so the package keeps parity.
- Speech ducking: while any speak clip plays, music master gain dips to ~40%
  and recovers after — dialogue always wins.
