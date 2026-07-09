# Contributing

Run `./setup.sh` then `node server.js` to get a working stage at
`http://localhost:3123`. See README.md for prerequisites and details.

## What not to commit

`.gitignore` already excludes these — keep it that way, don't add exceptions.

- **`.claude/settings.local.json`** — local Claude Code settings. Contains
  machine-specific absolute paths and local dev tokens. Never commit.
- **`tools/`** — the Rhubarb Lip Sync binary, fetched by `setup.sh`.
  Platform-specific and too large to vendor.
- **`cache/`** — generated TTS audio and viseme JSON, keyed by content hash.
  Disposable; regenerates on demand.
- **`.venv/`, `__pycache__/`, `*.pyc`** — Python artifacts from testing the
  dbbasic integration locally.
- Standard junk: **`.DS_Store`**, **`*.log`**, **`nohup.out`**.

General rule: never commit real secrets, API keys, tokens, passwords, private
hostnames/IPs, or absolute paths that leak a username. Rendered speech audio
and any personal test recordings stay out too.

**Before you push**, run `git status` and skim the staged file list. If
anything above shows up, `.gitignore` was bypassed (e.g. `git add -f`) —
don't commit it.

## Adding a character

Characters are data-only folders under `characters/<name>/` — a `puppet.svg`
with the nine `#mouth-*` viseme groups plus a `manifest.json` describing
mouths, views, actions, etc. See README.md's "Making a new character" for the
full contract; don't special-case a character name in JS.

## The dbbasic-object-server package

`integrations/dbbasic/` is a package port of the app for
[dbbasic-object-server](https://github.com/askrobots/dbbasic-object-server).
`integrations/dbbasic/puppet-stage/objects/puppet/stage.py` is **generated**
by `integrations/dbbasic/build.py` — never hand-edit it. Re-run `build.py`
after changing anything in `public/` or `characters/`. See
`integrations/dbbasic/README.md` for the install/test workflow.
