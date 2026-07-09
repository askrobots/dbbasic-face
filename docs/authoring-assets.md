# Authoring assets

A practical guide to adding backgrounds, props, and overlays — the
non-character assets used by frames and scenes. For the full cue schema and
screenplay grammar these assets plug into, see
[docs/design/frames-and-scenes.md](design/frames-and-scenes.md).

## The `assets/` layout

```text
assets/
  backgrounds/<id>.svg      # full-frame backdrops
  props/<id>.svg            # small set-dressing pieces
  overlays/<id>.svg         # overlay templates with named text slots
```

Grouped by kind so packs stay reviewable at a glance. `characters/<name>/`
stays a separate tree — a character is a puppet with a manifest, not a scene
asset, even when it's loaded into a frame as a framed head.

## Format-agnostic resolution

An asset id doesn't name a file, it names a slot. For id `foo` in kind
`<kind>`, the server tries `assets/<kind>/foo.svg`, then `.png`, `.jpg`,
`.jpeg`, `.webp`, `.gif`, and serves the first one that exists. Raster drops
into the same slot as SVG with no code change — an AI-generated
`backgrounds/desk.png` is exactly as valid as the hand-drawn
`backgrounds/desk.svg` it could replace. We ship the starter pack in SVG
because it's hand-authorable and stays crisp at any frame size, not because
the format is required.

## Backgrounds

`assets/backgrounds/<id>.svg` — full-frame backdrops referenced by `bg` in
`frame` and `scene` cues (`[frame left bg:desk]`, `[scene room]`).

- Use a roughly 16:9 `viewBox` (the shipped set uses `0 0 320 180`) since
  frames are wide rectangles by default.
- The background is scaled to cover the frame, not fit inside it — keep the
  composition centered and avoid detail near the edges, since it may be
  cropped depending on the frame's aspect ratio.

## Props

`assets/props/<id>.svg` — small pieces (a mug, a plant, a desk) placed within
a scene rather than filling it.

- Use a tight `viewBox` sized to the prop itself (the shipped `mug.svg` is
  `0 0 100 100`), not the full stage.
- No full-canvas background rect — leave the canvas transparent so the prop
  composites over whatever backdrop is behind it.

## Overlay templates

`assets/overlays/<id>.svg` — used by `overlay` cues (`[lower-third "Name"
"Title"]`), rendered above every frame.

- Must be SVG or HTML, never raster — an overlay needs text slots to fill,
  and a raster image has no slots to mark.
- Mark each fillable piece of text with `data-slot="<name>"` on the element,
  e.g. `<text data-slot="title" ...>Name</text>`. The runtime replaces that
  element's text from the matching key in the cue's `slots` map
  (`{"title": "Ava Reyes", "subtitle": "Host"}`).
- Everything else in the template — bars, colors, layout — is ordinary SVG
  and renders as authored; only elements carrying `data-slot` get rewritten.

## Adding a new asset

1. Drop a file at `assets/<kind>/<id>.svg` (or a raster equivalent) — no
   registration step, the id is just the filename stem.
2. Reference it by id from a `frame`, `scene`, `content`, or `overlay` cue, or
   from the matching screenplay direction.
3. Reload the stage. Backgrounds and props render immediately from the
   `bg` / `content` fields; overlay templates need `data-slot` markers to
   accept text.

For the complete list of cue types, slot names, and screenplay directions
that reference these assets, see
[docs/design/frames-and-scenes.md](design/frames-and-scenes.md).
