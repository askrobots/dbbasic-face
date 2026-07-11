# Puppet Stage as a DBBASIC package

Packages the puppet stage for
[dbbasic-object-server](https://github.com/askrobots/dbbasic-object-server):
four objects, no Node required on the serving side (the director still talks
to a running Node stage app over HTTP — see below).

| object            | role                                                            |
|-------------------|-----------------------------------------------------------------|
| `puppet_stage`    | the whole stage page (HTML + runtime + embedded characters)      |
| `puppet_speak`    | text → TTS → Rhubarb visemes; audio returned as a data URI       |
| `puppet_cues`     | the direction bus: POST cues, stages poll `?since=seq` (~350 ms) |
| `puppet_director` | OpenAI-backed stage director: writes, performs, and reviews shows, and vision-reviews character animations |

`objects/puppet/stage.py` is **generated** — run `python3 build.py` after
changing `public/stage.js`, `public/index.html`, `shim.js`, or anything in
`characters/`. The page embeds the verbatim `stage.js` behind a small adapter
(`shim.js`) that fakes `EventSource` with polling and maps `/api/*` onto the
objects, so the package cannot drift from the main app.

Frame, scene, and overlay directions (see the main README's "Scenes, frames &
overlays" section) work through this package too — `shim.js` mirrors the same
screenplay grammar, so scripts behave identically here and in the Node app.

## Install

Machine running the object server needs `ffmpeg`, macOS `say` and/or
`espeak`, and (for real lip-sync) the Rhubarb binary reachable via `$PATH` or
`RHUBARB_PATH` in the server's environment.

```sh
python3 build.py                               # regenerate stage.py
cp -R puppet-stage /path/to/server/packages/   # or DBBASIC_PACKAGES_DIR

# server env: DBBASIC_ENABLE_PACKAGE_INSTALLS=true, admin token set
curl -H "Authorization: Token $TOKEN" \
     'http://127.0.0.1:8001/packages/puppet-stage?dry_run=true'
curl -X POST -H "Authorization: Token $TOKEN" \
     'http://127.0.0.1:8001/packages/puppet-stage/install'
```

Open `/objects/puppet_stage` in a browser. Direct it from anywhere:

```sh
curl -X POST -H 'Content-Type: application/json' \
     -d '{"type":"say-text","text":"Hello!","voice":"Samantha"}' \
     http://127.0.0.1:8001/objects/puppet_cues
curl -X POST -H 'Content-Type: application/json' \
     -d '{"type":"action","name":"wave"}' http://127.0.0.1:8001/objects/puppet_cues
curl -X POST -H 'Content-Type: application/json' \
     -d '{"type":"view","mode":"face"}' http://127.0.0.1:8001/objects/puppet_cues
```

Any object inside the server can do the same with a local HTTP call — that is
the hook for AI/dashboard objects that want a talking face.

## The director object

`puppet_director` is an OpenAI-backed stage director. It writes screenplays
against the grammar in the main README ("Screenplay language" and "Scenes,
frames & overlays"), lints them in plain Python before performing them,
optionally critiques a performance with vision (screenshots at 3 points in
the show, tiled by `ffmpeg` into one early/mid/late filmstrip), and can
audition a character's actions by capturing 4 screenshots across each
action's timeline (~15/40/65/90% of its duration) and tiling those into one
filmstrip per action, so the vision model judges **motion** — a smooth arc,
not just a single frozen pose — asking whether each one reads as intended.

Unlike the other three objects, it does not run "inside" the package — it
directs a **running Node stage app** (`server.js`) over plain HTTP, fetching
`/api/characters`, `/api/assets`, and each character's `manifest.json` live
(cached 60s) so it only ever references real characters/actions/assets, and
posting finished screenplays to `/api/script`.

Env vars: `OPENAI_API_KEY` (or `OPENAI_KEY_FILE`, a path to a `.env`-style
file containing an `OPENAI_API_KEY=...` line — the key itself is never
logged or returned), `OPENAI_MODEL` (default `gpt-5.4-mini`, verified
working against the existing chat-completions payload — temperature and all
— with no param changes needed), `PUPPET_BASE` (default
`http://127.0.0.1:3123`, the Node stage app to direct).

```sh
# write, lint, and perform a screenplay
curl -X POST -H 'Content-Type: application/json' \
     -d '{"prompt":"Mae teases Gus about his glasses; he adjusts them; one sfx"}' \
     http://127.0.0.1:8001/objects/puppet_director

# same, then vision-critique 3 screenshots of the performance
curl -X POST -H 'Content-Type: application/json' \
     -d '{"prompt":"A campfire ghost story, one character, spooky sfx","review":true}' \
     http://127.0.0.1:8001/objects/puppet_director

# vision-audition a character's actions (screenshots each pose)
curl -X POST -H 'Content-Type: application/json' \
     -d '{"review_character":"rex","actions":["leap","wag"]}' \
     http://127.0.0.1:8001/objects/puppet_director
```

**Cost:** every call spends your own OpenAI key — one chat completion per
compose (two if the lint retry fires), plus one vision call per `review` or
`review_character`. Defaults to `gpt-5.4-mini` to keep this cheap; set
`OPENAI_MODEL` for a stronger writer/critic if quality matters more than
cost, or a cheaper one for high-volume auditioning. Current pricing (July
2026): `gpt-5.4-mini` $0.75/M input, $4.50/M output tokens; `gpt-5.4-nano`
$0.20/$1.25 (budget option); `gpt-5.4` $2.50/$15 and `gpt-5.5` $5/$30 for
higher quality — set via `OPENAI_MODEL`.

**Caveat:** `review` and `review_character` shell out to headless Firefox
*on the machine running the object server* (the same `?shot&d=<ms>`
screenshot harness the main app's CLAUDE.md documents) to capture what the
stage actually looks like, and to `ffmpeg` to tile those screenshots into
one filmstrip image per performance/action (see "Install" above — `ffmpeg`
is already a prerequisite). That's dev-friendly on a workstation but not a
cloud-portable design — there's no headless browser in most object-server
deployments, so these two modes are expected to degrade (skip vision, note
why) anywhere Firefox isn't installed. If Firefox works but `ffmpeg` tiling
fails, both modes fall back to sending the individual (un-tiled) screenshots
instead of one filmstrip, and note `"strip": false` in the result rather
than failing outright. Plain composing/performing needs nothing but network
access to `PUPPET_BASE` and the OpenAI API.

## Differences from the Node app

- **Polling, not SSE** (~350 ms cue latency). The object server's realtime
  direction doc plans WebSocket/SSE event streams; when those land, the shim's
  `PollingEventSource` is the one class to replace.
- **Speech renders per viewer**: `say-text` cues carry text; each open stage
  calls `puppet_speak` itself and plays the (deterministic) result. No audio
  files are stored server-side.
- **The screenplay runner executes in the browser** that pressed Run,
  broadcasting cues through the queue so all viewers stay in sync.
- **No `/api/speak-audio` equivalent yet** — external pre-rendered audio would
  need either object-file storage or fatter cues; add when needed.
- The cue queue is a live bus (last 60 cues), not a history, and concurrent
  writers can race; it is not a ledger.
