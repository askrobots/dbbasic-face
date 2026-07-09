# Puppet Stage as a DBBASIC package

Packages the puppet stage for
[dbbasic-object-server](https://github.com/askrobots/dbbasic-object-server):
three objects, no Node required on the serving side.

| object         | role                                                            |
|----------------|-----------------------------------------------------------------|
| `puppet_stage` | the whole stage page (HTML + runtime + embedded characters)      |
| `puppet_speak` | text → TTS → Rhubarb visemes; audio returned as a data URI       |
| `puppet_cues`  | the direction bus: POST cues, stages poll `?since=seq` (~350 ms) |

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
