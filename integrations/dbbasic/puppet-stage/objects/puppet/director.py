"""Puppet Stage director: OpenAI-backed screenplay writer/performer/critic.

POST {"prompt": "...", "perform": true, "review": false}
  COMPOSE: writes a screenplay (grammar below), lints it in plain Python (one
  retry on failure, errors appended to the conversation), performs it via
  POST {PUPPET_BASE}/api/script -> {"status":"ok","script":...,"lint":"clean",
  "performed":...}.
POST {"prompt": "...", "review": true, "apply_revision": false}
  compose+perform, then REVIEW: headless Firefox can't "join" a running show,
  so v1 re-performs the same script two more times (3 short performances),
  screenshotting each via the stage's `?shot&d=<ms>` harness at a different
  point in the timeline, tiles the 3 frames into ONE early|mid|late filmstrip
  via ffmpeg (hstack + downscale to 1536px wide), then one vision call over
  that single strip + the script for a critique (falls back to sending the 3
  frames separately, noting "strip": false, if ffmpeg tiling fails).
  apply_revision also performs the model's revised_script. Screenshot/cue
  timing is anchored to server-observed navigation (see "screenshot timing"
  below), not a fixed sleep after spawning Firefox, so the early/mid/late
  offsets land where they're supposed to regardless of browser startup
  jitter.
POST {"review_character": "<name>", "actions": [optional subset]}
  AUDITION: fires each action FOUR times (spawn Firefox holding
  ?shot&d=<ms>, post the action cue once navigation is confirmed, vary d per
  shot so the load-hold lands the screenshot at ~15/40/65/90% of the
  action's duration -- read from the character's manifest tracks, max track
  duration, default 1000ms), tiles the 4 frames into ONE filmstrip per
  action via ffmpeg (falls back to a single mid-action frame, noting
  "strip": false, if ffmpeg tiling fails), plus one rest-pose still, then
  one vision call (1 rest + up to 5 action filmstrips fits the
  6-image-per-call budget) judging the MOTION across each strip. ~4
  screenshots per action, so the action cap stays at 5. Every one of those
  shots is a FRESH Firefox page (a fresh page always boots the module's
  default character), so each `_shoot_at_phase` call gets a `prep_fn` that
  POSTs {"type":"character","name":<name>} at nav+1.5s -- well before the
  nav+3.0s action cue -- so the audited character (not the default) is
  actually on stage for every rest shot and every filmstrip frame.
GET -> {"status":"ok","usage": {...}}

Screenshot timing: Firefox startup jitters 1-3s between spawn and actual
navigation, so cueing actions/scripts a fixed delay after spawning Firefox
puts the cue at an unpredictable phase (often before the page has even
connected), producing static filmstrips. Instead the harness polls the
stage server's GET /api/last-shot (set at the top of the server's /slowpx
handler, which the page requests immediately on navigation) until it
reports a value newer than a pre-spawn baseline -- that detection instant L
is treated as ~= navigation time. Every cue (action POST /api/cue, or the
POST /api/script that starts a show for review) fires at exactly L+3.0s,
comfortably after the page has booted and connected its SSE stream; the
`?shot&d=` hold is varied per shot (3000 + offset_ms) so the shutter lands
`offset_ms` after the cue, landing the screenshot at whatever phase/offset
into the action or show timeline is wanted -- independent of how long
Firefox took to actually start. Falls back to the old fixed-sleep-after-
spawn behavior if /api/last-shot 404s (older server without the route).

Config (env): PUPPET_BASE (default http://127.0.0.1:3123), OPENAI_MODEL
(default gpt-5.4-mini -- verified working with the existing chat-completions
payload, temperature included, no param changes needed; set to gpt-5.4-nano
for a cheaper writer/critic or gpt-5.4/gpt-5.5 for a stronger one),
OPENAI_API_KEY or OPENAI_KEY_FILE (path to a .env-style file with an
OPENAI_API_KEY=... line). Key is never logged or returned. Zero third-party
deps: urllib.request against api.openai.com, subprocess for headless Firefox
and for ffmpeg (composites review/audition frames into single filmstrip
images; falls back to sending un-tiled frames if ffmpeg tiling fails).
Character/asset lists are fetched live from PUPPET_BASE and cached
in-module for 60s so the model can't invent a name. Firefox/screenshot/
ffmpeg failures degrade review/audition (skip vision, or fall back to
un-tiled frames) instead of failing the whole request.
"""

import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

BASE = os.environ.get("PUPPET_BASE", "http://127.0.0.1:3123").rstrip("/")
MODEL = os.environ.get("OPENAI_MODEL", "gpt-5.4-mini")
FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox"
FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
OPENAI_URL = "https://api.openai.com/v1/chat/completions"

GRAMMAR = """SCREENPLAY GRAMMAR (plain text file, one or more directions per bracket line)
  # comment                          ignored
  Hello there.                       plain line = spoken by the main/current character
  left: Hi!                          "id: text" = spoken by that frame/actor id (see NAMES below)
  (wave) Hi!                         (action) prefix = fires an action while the line is spoken
  [wave]                             a line of one-or-more space-joined [direction] groups
Directions (inside [...]):
  walk to N | enter from left|right | exit left|right   move/enter/exit (N = % of stage width;
                                       N also accepts left|center|middle|right as 25/50/75 —
                                       NOTE: for enter/exit specifically, left|right mean
                                       off-stage sides, not the 25/75 on-stage positions)
  wait N                              pause N seconds
  look left|right|up|down|front       gaze direction
  view face|body                      camera framing (close-up / full stage)
  emote <name>                        named pose/expression action
  <action-name>                       any action from the character's manifest (wave, jump, nod, bow, ...)
  engine say|espeak                   switch TTS engine
  voice <name>                        TTS voice name
  rate <n>                            TTS rate
  captions on|off                     subtitle overlay for spoken lines
  iris in|out [ms] | fade in|out [ms] fullscreen transition, default 700ms
  layout single|split|thirds|pip-tr|pip-tl|pip-br|pip-bl   set frame layout
  frame <id> [slot:<s>] [bg:<id>] [character:<name>] [view:face|body] [facing:-1|1]
  frame <id> clear                    remove a frame
  scene <bg-id>                       set the current scene's background
  show text:"..."|image:<id>|video:<id> [fit:contain|cover]   content tile
  lower-third "Title" "Subtitle" [hold:<ms>]   broadcast caption bar (default hold 6000ms)
  lower-third clear                   remove it
  place <what> at <x> [id:<id>] [scale:<n>] [behind]   add a prop or character actor
                                       (<x> also accepts left|center|middle|right as 25/50/75)
  remove <id>                         remove a placed actor
  wear <target> <prop> [scale:<n>] [anchor:<name>]   pin a prop to a character/actor (anchor default head)
  unwear <target> [anchor]
  music <id> | music off              background loop
  sfx <id>                            one-shot sound effect
  clear                               wipe placed actors/worn props/content/overlays
  [<frame-or-actor-id-or-name> <direction>]   route any direction above at a frame, actor,
                                       or character NAME, e.g. [left wave] [hoop1 spin] [rex sit]
NAMES: once a character has been framed ([frame left character:rex]) or placed
([place rex at 30]), you may address it directly BY NAME instead of the frame/
actor id — [rex sit], rex: Woof!, [wear rex tophat] all resolve to whichever
frame/actor rex currently occupies. Resolution order everywhere (head token of
a [direction], a speaker prefix, and wear/unwear targets) is: frame id, then
actor id, then character name. A character name is NOT usable until it has
been framed or placed at least once earlier in the script.
Speaker lines are written as "name: text" on their own line — NEVER wrap a
speaker line in brackets like "[name: text]" (it is tolerated by the parser
as a fallback, but always prefer the unbracketed form).
"""

_LINE_BRACKETS = re.compile(r"^(\[[^\]]+\]\s*)+$")
_BRACKET = re.compile(r"\[([^\]]+)\]")
_SPEAKER = re.compile(r"^([A-Za-z][\w-]*):\s*(.*)$")
_INLINE = re.compile(r"^\(([^)]+)\)\s*(.*)$")
_KV = re.compile(r'(\w+):"([^"]*)"|(\w+):(\S+)')
_LAYOUTS = {
    "single": ["main"], "split": ["left", "right"],
    "thirds": ["third-l", "third-c", "third-r"],
    "pip-tr": ["main", "pip"], "pip-tl": ["main", "pip"],
    "pip-br": ["main", "pip"], "pip-bl": ["main", "pip"],
}
_SIMPLE_DIRECTIONS = {
    "walk", "enter", "exit", "wait", "look", "view", "zoom", "emote",
    "engine", "voice", "rate", "captions", "iris", "fade", "clear",
}

class _OpenAIError(Exception):
    pass

def _parse_kv(s):
    out = {}
    for m in _KV.finditer(s):
        if m.group(1) is not None:
            out[m.group(1)] = m.group(2)
        else:
            out[m.group(3)] = m.group(4)
    return out

# --------------------------------------------------------------- OpenAI API

def _api_key():
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    if key:
        return key
    path = os.environ.get("OPENAI_KEY_FILE", "").strip()
    if not path or not os.path.exists(path):
        return ""
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("OPENAI_API_KEY="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""

def _openai_chat(messages, response_format=None, temperature=0.8):
    key = _api_key()
    if not key:
        raise _OpenAIError("no API key configured (OPENAI_API_KEY or OPENAI_KEY_FILE)")
    body = {"model": MODEL, "messages": messages, "temperature": temperature}
    if response_format:
        body["response_format"] = response_format
    req = urllib.request.Request(
        OPENAI_URL, data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:300]
        raise _OpenAIError(f"OpenAI {exc.code}: {detail}") from None
    except urllib.error.URLError as exc:
        raise _OpenAIError(f"OpenAI request failed: {str(exc.reason)[:200]}") from None
    parsed = json.loads(raw)
    try:
        return parsed["choices"][0]["message"]["content"]
    except (KeyError, IndexError):
        raise _OpenAIError(f"unexpected OpenAI response shape: {str(parsed)[:200]}") from None

# -------------------------------------------------------- capabilities/caps

_cap_cache = {"ts": 0.0, "data": None}

def _http_get(url, timeout=10):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read())

def _http_post(url, payload, timeout=10):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())

def _capabilities(force=False):
    now = time.time()
    if not force and _cap_cache["data"] is not None and now - _cap_cache["ts"] < 60:
        return _cap_cache["data"]
    names = _http_get(f"{BASE}/api/characters").get("characters", [])
    assets = _http_get(f"{BASE}/api/assets")
    cast = []
    for name in names:
        try:
            manifest = _http_get(f"{BASE}/characters/{name}/manifest.json")
        except Exception:
            manifest = {}
        cast.append({
            "name": name,
            "actions": sorted((manifest.get("actions") or {}).keys()),
            "voice": manifest.get("voice") or {},
        })
    data = {"cast": cast, "assets": assets}
    _cap_cache["data"], _cap_cache["ts"] = data, now
    return data

def _cap_prompt_block(cap):
    lines = ["AVAILABLE CAST (use ONLY these names):"]
    for c in cap["cast"]:
        lines.append(f"- {c['name']}: actions=[{', '.join(c['actions']) or 'none'}] voice={c['voice']}")
    a = cap["assets"]
    lines.append(f"BACKGROUNDS: {', '.join(a.get('backgrounds', []))}")
    lines.append(f"PROPS: {', '.join(a.get('props', []))}")
    lines.append(f"OVERLAYS: {', '.join(a.get('overlays', []))}")
    lines.append(f"MUSIC: {', '.join(a.get('music', []))}")
    lines.append(f"SFX: {', '.join(a.get('sfx', []))}")
    return "\n".join(lines)

# ----------------------------------------------------------------- linting

def _lint(script, cap):
    cast_names = {c["name"] for c in cap["cast"]}
    action_names = {a for c in cap["cast"] for a in c["actions"]} | {"neutral"}
    assets = cap["assets"]
    bg_ids, prop_ids = set(assets.get("backgrounds", [])), set(assets.get("props", []))
    music_ids, sfx_ids = set(assets.get("music", [])), set(assets.get("sfx", []))
    errors = []
    frame_ids, actor_ids = {"main"}, set()

    def check(body, lineno):
        parts = body.strip().split()
        if not parts:
            errors.append(f"line {lineno}: empty direction []")
            return
        head, rest = parts[0].lower(), parts[1:]
        rest_str = " ".join(rest)
        if head == "layout":
            preset = rest[0].lower() if rest else "single"
            if preset not in _LAYOUTS:
                errors.append(f"line {lineno}: unknown layout '{preset}'")
            else:
                frame_ids.clear(); frame_ids.update(_LAYOUTS[preset])
            return
        if head == "frame":
            if not rest:
                errors.append(f"line {lineno}: [frame] needs an id"); return
            fid = rest[0]
            if " ".join(rest[1:]).strip().lower().startswith("clear"):
                frame_ids.discard(fid); return
            kv = _parse_kv(" ".join(rest[1:]))
            if "character" in kv and kv["character"] not in cast_names:
                errors.append(f"line {lineno}: unknown character '{kv['character']}' in [frame]")
            if "bg" in kv and kv["bg"] not in bg_ids:
                errors.append(f"line {lineno}: unknown background '{kv['bg']}' in [frame]")
            frame_ids.add(fid)
            return
        if head == "scene":
            if rest_str and rest_str not in bg_ids:
                errors.append(f"line {lineno}: unknown background '{rest_str}' in [scene]")
            return
        if head in ("show", "lower-third"):
            return  # free-form content/text, not asset-validated
        if head == "music":
            if rest and rest[0].lower() != "off" and rest[0] not in music_ids:
                errors.append(f"line {lineno}: unknown music id '{rest[0]}'")
            return
        if head == "sfx":
            if not rest or rest[0] not in sfx_ids:
                errors.append(f"line {lineno}: unknown sfx id '{rest[0] if rest else ''}'")
            return
        if head == "place":
            if not rest:
                errors.append(f"line {lineno}: [place] needs a name"); return
            what = rest[0]
            kv = _parse_kv(" ".join(rest[1:]))
            if what not in cast_names and what not in prop_ids:
                errors.append(f"line {lineno}: unknown actor/prop '{what}' in [place]")
            actor_ids.add(kv.get("id", what))
            return
        if head == "remove":
            if rest:
                actor_ids.discard(rest[0])
            return
        if head == "wear":
            if len(rest) < 2:
                errors.append(f"line {lineno}: [wear] needs a target and a prop"); return
            target, prop = rest[0], rest[1]
            # target resolves frame id -> actor id -> character name, same
            # order the real parser applies (a name works once framed/placed
            # earlier in the script; the lint doesn't track exactly where,
            # it just trusts any known cast name).
            if target not in frame_ids and target not in actor_ids and target not in cast_names:
                errors.append(f"line {lineno}: unknown wear target '{target}'")
            if prop not in prop_ids:
                errors.append(f"line {lineno}: unknown prop '{prop}' in [wear]")
            return
        if head == "unwear":
            if not rest:
                errors.append(f"line {lineno}: [unwear] needs a target"); return
            if rest[0] not in frame_ids and rest[0] not in actor_ids and rest[0] not in cast_names:
                errors.append(f"line {lineno}: unknown unwear target '{rest[0]}'")
            return
        if head in _SIMPLE_DIRECTIONS:
            return
        # A name-addressed direction ([rex sit]) routes the same way a
        # frame/actor id does, once rex is a known cast member.
        if (head in frame_ids or head in actor_ids or head in cast_names) and rest:
            check(rest_str, lineno)
            return
        if head in ("move", "scale", "spin", "bounce"):
            return  # only meaningful as a routed actor sub-direction
        if head not in action_names:
            errors.append(f"line {lineno}: unknown direction/action '{head}'")

    for lineno, raw in enumerate(script.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.count("[") != line.count("]"):
            errors.append(f"line {lineno}: unbalanced brackets")
            continue
        if _LINE_BRACKETS.match(line):
            for m in _BRACKET.finditer(line):
                inner = m.group(1).strip()
                # Tolerance mirrors the parser: "[label: text]" is a spoken
                # line wearing brackets by mistake, not a direction, as long
                # as the label resolves to a frame/actor id or a known cast
                # name — skip direction-validating it.
                sm = _SPEAKER.match(inner)
                if sm and (sm.group(1) in frame_ids or sm.group(1) in actor_ids or sm.group(1) in cast_names):
                    continue
                check(inner, lineno)
            continue
        if "[" in line or "]" in line:
            errors.append(f"line {lineno}: stray brackets outside a direction-only line: {line[:60]}")
            continue
        text = line
        m = _SPEAKER.match(text)
        if m:
            label = m.group(1)
            # A frame/actor id, or (once framed/placed) a character name,
            # is a valid speaker prefix — mirrors the parser's charLocs
            # resolution (frame id -> actor id -> character name).
            if label in frame_ids or label in actor_ids or label in cast_names:
                text = m.group(2)
        im = _INLINE.match(text)
        if im:
            check(im.group(1), lineno)
    return errors

def _strip_fences(text):
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[\w-]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text)
    return text.strip()

def _main_character(script, cap):
    best, best_pos = None, None
    for name in {c["name"] for c in cap["cast"]}:
        m = re.search(r"\b" + re.escape(name) + r"\b", script)
        if m and (best_pos is None or m.start() < best_pos):
            best, best_pos = name, m.start()
    return best

# ----------------------------------------------------------------- compose

def _compose(prompt, cap):
    system = (
        "You are a stage director for a cue-driven puppet theater.\n\n"
        + GRAMMAR + "\n" + _cap_prompt_block(cap) + "\n\n"
        "RULES:\n"
        "- Only use names/ids listed above; never invent a character, action, or asset.\n"
        "- Write a complete screenplay, ~15-45 seconds performed (roughly 4-10 lines).\n"
        "- Start with [captions on] and a transition/entrance in (e.g. [fade in] or [enter from left]).\n"
        "- End with a transition out (e.g. [exit right] or [fade out]).\n"
        "- Keep spoken lines short and performable (under ~12 words).\n"
        "- Multi-character scenes need [layout split] + [frame left character:X]"
        " [frame right character:Y] with left:/right: speaker prefixes.\n"
        "- Once a character is framed or placed, you may address it by name directly"
        " ([rex sit], rex: Woof!, [wear rex tophat]) instead of the frame/actor id.\n"
        "- Positions accept left|center|middle|right as well as 0-99 percent numbers.\n"
        "- Write speaker lines as `name: text` on their own line, never wrapped in"
        " brackets like `[name: text]`.\n"
        "- Output ONLY the screenplay text: no markdown fences, no explanation."
    )
    messages = [{"role": "system", "content": system}, {"role": "user", "content": prompt}]
    script = _strip_fences(_openai_chat(messages))
    errors = _lint(script, cap)
    if errors:
        messages.append({"role": "assistant", "content": script})
        messages.append({"role": "user", "content": "fix these:\n" + "\n".join(errors)})
        script2 = _strip_fences(_openai_chat(messages))
        errors2 = _lint(script2, cap)
        if not errors2:
            return script2, []
        return script2, errors2
    return script, []

def _perform(script, main_char):
    payload = {"script": script}
    if main_char:
        payload["mainCharacter"] = main_char
    _http_post(f"{BASE}/api/script", payload)

# --------------------------------------------------------- screenshot harness

# `?shot&d=<ms>` (see main README/CLAUDE.md) holds the page's `load` event
# open for <ms> via a `document.write`'n <img src="/slowpx?d=<ms>">; Firefox's
# --screenshot waits for `load`, so `d` is purely "how long from navigation
# start to shutter", independent of anything else.
#
# Firefox startup (spawn -> actual navigation) jitters ~1-3s, so a cue fired
# a fixed delay after *spawning* Firefox lands at an unpredictable phase --
# the root cause of the nondeterministic/static filmstrips this harness used
# to produce. Instead we anchor to navigation itself, which the *server* can
# observe: the page requests /slowpx immediately on load, and the server
# stamps that instant (see /api/last-shot in server.js). The harness polls
# for a fresh /api/last-shot value after spawning Firefox; the poll-detected
# instant L is treated as ~= navigation (detection lag is bounded by the
# poll interval). Every cue then fires at exactly L + _CUE_DELAY seconds --
# comfortably after the page's JS has booted and connected its SSE stream --
# and the requested `?shot&d=` hold is _CUE_DELAY*1000 + offset_ms, so the
# shutter lands `offset_ms` after the cue regardless of how long Firefox
# actually took to start. _BOOT_DELAY is kept only as the fixed-sleep
# fallback for servers that don't expose /api/last-shot.
_CUE_DELAY = 3.0  # seconds after detected navigation that every cue fires at
_PREP_DELAY = 1.5  # seconds after detected navigation that an optional prep_fn fires at (before cue_fn)
_BOOT_DELAY = 2.2  # seconds (fallback-only: fixed sleep after spawn, pre-nav-anchoring behavior)
_POLL_INTERVAL = 0.1  # seconds between /api/last-shot polls
_POLL_TIMEOUT = 15.0  # seconds to wait for a fresh /api/last-shot before giving up
_PHASES = (0.15, 0.40, 0.65, 0.90)  # filmstrip frame offsets across an action

def _last_shot_t():
    """GET {BASE}/api/last-shot -> the server-clock ms of the most recent
    /slowpx (navigation) request, or None if the server doesn't expose the
    route (404 -> older server, so the caller should fall back to the fixed
    -sleep-after-spawn timing). Any other failure propagates, same as every
    other _http_get call in this module."""
    try:
        return _http_get(f"{BASE}/api/last-shot", timeout=5).get("t") or 0
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise

def _wait_for_nav(t_before, timeout=_POLL_TIMEOUT):
    """Poll /api/last-shot every _POLL_INTERVAL until it reports a value
    newer than t_before (a fresh /slowpx request = the page just navigated),
    or timeout. Returns local time.time() at the detecting poll (treated as
    ~= navigation time) or None on timeout."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        t = _last_shot_t()
        if t and t > t_before:
            return time.time()
        time.sleep(_POLL_INTERVAL)
    return None

def _shoot_at_phase(cue_fn, offset_ms, out_path, timeout, prep_fn=None):
    """Nav-anchored screenshot capture. Spawns headless Firefox holding
    `?shot&d=<_CUE_DELAY*1000 + offset_ms>`, waits until the server reports
    a fresh navigation (via /api/last-shot), then sleeps until exactly
    _CUE_DELAY seconds after that detected navigation and invokes `cue_fn()`
    (a zero-arg callable that fires whatever cue matters -- an action POST,
    or the POST that starts a show for review; pass None for a plain no-cue
    still). If `prep_fn` is given, it's invoked first, at exactly
    _PREP_DELAY seconds after detected navigation (the page has connected
    by then, and a prep POST like loading a character is fast/local) --
    e.g. to put the right character on THIS fresh page before its action
    cue fires, since every freshly spawned page boots the module's default
    character. Since the shutter fires at nav + d_ms = nav + _CUE_DELAY*1000
    + offset_ms, and cue_fn fires at nav + _CUE_DELAY*1000 regardless of
    whether prep_fn ran, the screenshot still lands exactly `offset_ms`
    after cue_fn -- independent of Firefox startup jitter between spawn and
    actual navigation.
    Falls back to the old fixed-sleep-after-spawn behavior (prep_fn, if
    given, fires _CUE_DELAY - _PREP_DELAY seconds before cue_fn, which
    itself fires at _BOOT_DELAY after spawn; d_ms = _BOOT_DELAY*1000 +
    offset_ms) if the server doesn't expose /api/last-shot (404 -> older
    server).
    Writes the PNG to out_path; caller owns cleanup."""
    if not os.path.exists(FIREFOX):
        raise RuntimeError(f"firefox not found at {FIREFOX}")
    t_before = _last_shot_t()
    fallback = t_before is None
    d_ms = int((_BOOT_DELAY if fallback else _CUE_DELAY) * 1000 + offset_ms)
    profile = tempfile.mkdtemp(prefix="ffprof-")
    try:
        proc = subprocess.Popen(
            [FIREFOX, "--headless", "--new-instance", "--profile", profile,
             "--screenshot", out_path, "--window-size=1280,760", f"{BASE}/?shot&d={d_ms}"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if fallback:
            if prep_fn:
                prep_wait = max(_BOOT_DELAY - (_CUE_DELAY - _PREP_DELAY), 0)
                time.sleep(prep_wait)
                prep_fn()
                remaining = _BOOT_DELAY - prep_wait
                if remaining > 0:
                    time.sleep(remaining)
            else:
                time.sleep(_BOOT_DELAY)
        else:
            nav_at = _wait_for_nav(t_before)
            if nav_at is None:
                raise RuntimeError("navigation not detected via /api/last-shot within timeout")
            if prep_fn:
                remaining = (nav_at + _PREP_DELAY) - time.time()
                if remaining > 0:
                    time.sleep(remaining)
                prep_fn()
            remaining = (nav_at + _CUE_DELAY) - time.time()
            if remaining > 0:
                time.sleep(remaining)
        if cue_fn:
            cue_fn()
        proc.wait(timeout=timeout)
        if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
            raise RuntimeError("screenshot not produced")
    finally:
        shutil.rmtree(profile, ignore_errors=True)

def _data_uri_from_file(path):
    with open(path, "rb") as fh:
        raw = fh.read()
    return "data:image/png;base64," + base64.b64encode(raw).decode()

def _ffmpeg_hstack(frame_paths, out_path, width=1536):
    """Composite N same-size screenshots into one horizontal filmstrip,
    downscaled to `width` so detail survives OpenAI's image tiling without
    waste. For 4 frames this runs:
      ffmpeg -y -i f1.png -i f2.png -i f3.png -i f4.png -filter_complex
        "[0][1][2][3]hstack=inputs=4,scale=1536:-1" strip.png
    Returns False (never raises) on any failure so callers can fall back to
    sending the individual frames."""
    n = len(frame_paths)
    if n < 2:
        return False
    inputs = []
    for p in frame_paths:
        inputs += ["-i", p]
    refs = "".join(f"[{i}]" for i in range(n))
    filt = f"{refs}hstack=inputs={n},scale={width}:-1"
    cmd = [FFMPEG, "-y"] + inputs + ["-filter_complex", filt, out_path]
    try:
        subprocess.run(cmd, capture_output=True, timeout=30, check=True)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError):
        return False
    return os.path.exists(out_path) and os.path.getsize(out_path) > 0

def _action_cue_fn(action):
    return lambda: _http_post(f"{BASE}/api/cue", {"type": "action", "name": action})

def _rest_shot(name, prep_fn=None):
    """Single still, rest pose (no action cue) -- shutter at nav+_CUE_DELAY
    (3s) gives the stage plenty of time to settle. `prep_fn`, if given,
    fires at nav+_PREP_DELAY to load `name` onto this fresh page first
    (every freshly spawned page otherwise boots the module's default
    character, not the audited one)."""
    fd, path = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        _shoot_at_phase(None, 0, path, timeout=_CUE_DELAY + 20, prep_fn=prep_fn)
        return _data_uri_from_file(path)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass

def _action_duration_ms(manifest, action):
    """Max track duration (ms) for an action in a character's manifest.json,
    defaulting to 1000ms if the action/tracks are missing or malformed."""
    tracks = ((manifest.get("actions") or {}).get(action) or {}).get("tracks") or []
    durations = [t.get("duration") for t in tracks
                 if isinstance(t.get("duration"), (int, float)) and t.get("duration") > 0]
    return max(durations) if durations else 1000

def _action_filmstrip(name, action, duration_ms, prep_fn=None):
    """Capture 4 frames across the action's timeline at ~15/40/65/90% (see
    _PHASES) and composite them into one horizontal filmstrip via ffmpeg,
    scaled to 1536px wide. Each frame is its own fresh Firefox page, so
    `prep_fn` (if given) is forwarded to every one of the 4 `_shoot_at_phase`
    calls to load `name` onto that page before its action cue fires --
    otherwise every fresh page boots the module's default character and
    the action never actually plays on the character being audited.
    Returns (images, strip_ok): on success `images` is a single-element
    list holding the strip data URI; on ffmpeg failure it's a single-
    element list holding just the ~40%-phase frame (the pre-filmstrip
    single-mid-action-shot behavior), so the overall image-per-call budget
    never grows, and strip_ok is False."""
    frame_paths = []
    try:
        cue_fn = _action_cue_fn(action)
        for phase in _PHASES:
            fd, path = tempfile.mkstemp(suffix=".png")
            os.close(fd)
            frame_paths.append(path)
            offset_ms = int(phase * duration_ms)
            _shoot_at_phase(cue_fn, offset_ms, path,
                             timeout=_CUE_DELAY + offset_ms / 1000 + 15, prep_fn=prep_fn)

        fd, strip_path = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            if _ffmpeg_hstack(frame_paths, strip_path, width=1536):
                return [_data_uri_from_file(strip_path)], True
            return [_data_uri_from_file(frame_paths[1])], False
        finally:
            try:
                os.remove(strip_path)
            except OSError:
                pass
    finally:
        for p in frame_paths:
            try:
                os.remove(p)
            except OSError:
                pass

# ------------------------------------------------------------------ review

def _estimate_duration(script):
    seconds = 0.0
    for raw in script.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if _LINE_BRACKETS.match(line):
            seconds += 1.0 * len(_BRACKET.findall(line))
            continue
        text = line
        m = _SPEAKER.match(text)
        if m:
            text = m.group(2)
        im = _INLINE.match(text)
        if im:
            seconds += 1.0
            text = im.group(2)
        seconds += 0.45 * len(text.split())
    return max(seconds, 3.0)

def _review_show(script, main_char):
    duration = _estimate_duration(script)
    labels = ["early", "middle", "late"]
    frame_paths = []
    try:
        cue_fn = lambda: _perform(script, main_char)  # noqa: E731 - fires POST /api/script (starts the show) at nav+_CUE_DELAY
        for label, frac in zip(labels, (0.2, 0.5, 0.85)):
            offset_ms = int(duration * 1000 * frac)
            fd, path = tempfile.mkstemp(suffix=".png")
            os.close(fd)
            frame_paths.append(path)
            _shoot_at_phase(cue_fn, offset_ms, path, timeout=_CUE_DELAY + offset_ms / 1000 + 20)
    except Exception as exc:
        for p in frame_paths:
            try:
                os.remove(p)
            except OSError:
                pass
        return {"status": "unavailable", "reason": f"screenshot failed: {str(exc)[:200]}"}

    strip_path = None
    try:
        fd, strip_path = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        strip_ok = _ffmpeg_hstack(frame_paths, strip_path, width=1536)
        if strip_ok:
            content = [{"type": "text", "text":
                        f"Screenplay (estimated ~{int(duration)}s, performed 3 separate times). "
                        f"The image is ONE filmstrip of 3 panels left-to-right: early, middle, "
                        f"late in the timeline:\n\n{script}"}]
            content.append({"type": "image_url",
                             "image_url": {"url": _data_uri_from_file(strip_path)}})
        else:
            content = [{"type": "text", "text":
                        f"Screenplay (estimated ~{int(duration)}s, performed 3 separate times; "
                        f"each image is a screenshot from a different run at the labeled point "
                        f"in the timeline):\n\n{script}"}]
            for label, path in zip(labels, frame_paths):
                content.append({"type": "text", "text": f"[{label}]"})
                content.append({"type": "image_url", "image_url": {"url": _data_uri_from_file(path)}})
    finally:
        for p in frame_paths:
            try:
                os.remove(p)
            except OSError:
                pass
        if strip_path:
            try:
                os.remove(strip_path)
            except OSError:
                pass

    system = (
        "You are reviewing a puppet-show performance for staging, timing, and "
        "continuity issues. The screenshots are supplied as one filmstrip image "
        "with 3 panels left-to-right (early, middle, late in the show) -- or, if "
        "tiling was unavailable, as 3 separately labeled screenshots. "
        "Return strict json only, no prose: "
        '{"issues":[{"when":"early|middle|late","what":"...","severity":"low|medium|high"}],'
        '"revised_script": "<full corrected screenplay>" or null}. '
        "Only set revised_script if issues are material enough to be worth rewriting."
    )
    messages = [{"role": "system", "content": system}, {"role": "user", "content": content}]
    try:
        raw = _openai_chat(messages, response_format={"type": "json_object"}, temperature=0.4)
    except _OpenAIError as exc:
        return {"status": "unavailable", "reason": str(exc)}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {"status": "error", "error": "vision critique was not valid json", "raw": raw[:500]}
    parsed.setdefault("status", "ok")
    parsed["strip"] = strip_ok
    return parsed

# ---------------------------------------------------------------- audition

def _audition(request):
    name = str(request.get("review_character", "")).strip()
    if not name:
        return {"status": "error", "error": "review_character required"}
    try:
        cap = _capabilities()
    except Exception as exc:
        return {"status": "error", "error": f"capabilities fetch failed: {str(exc)[:200]}"}
    entry = next((c for c in cap["cast"] if c["name"] == name), None)
    if not entry:
        return {"status": "error", "error": f"unknown character '{name}'"}
    requested = request.get("actions") or entry["actions"]
    # cap total images (1 rest still + up to 5 action filmstrips) at 6 per the vision-call image cap
    actions = [a for a in requested if a in entry["actions"]][:5]
    if not actions:
        return {"status": "error", "error": "no valid actions to audition"}

    try:
        manifest = _http_get(f"{BASE}/characters/{name}/manifest.json")
    except Exception:
        manifest = {}

    images = {}  # label -> (list of data-uris, strip_ok)
    strip_ok = True
    # Every shot below is a FRESH Firefox page, and a fresh stage page always
    # boots the module's default character -- so prep_fn (loading `name`) is
    # passed into EVERY _shoot_at_phase call (via _rest_shot/_action_filmstrip)
    # rather than posted once up front, which only affected pages that
    # happened to be open at that moment.
    prep_fn = lambda: _http_post(f"{BASE}/api/cue", {"type": "character", "name": name})  # noqa: E731
    try:
        images["rest"] = ([_rest_shot(name, prep_fn=prep_fn)], True)
        for action in actions:
            duration_ms = _action_duration_ms(manifest, action)
            frames, ok = _action_filmstrip(name, action, duration_ms, prep_fn=prep_fn)
            images[action] = (frames, ok)
            strip_ok = strip_ok and ok
    except Exception as exc:
        if not images:
            return {"status": "error", "error": f"unavailable: {str(exc)[:200]}"}
        _logger.warning("audition shot failed partway", error=str(exc)[:200])

    order = ["rest"] + [a for a in actions if a in images]
    content = [{"type": "text", "text":
                f"Character: {name}. Judging {len(order)} labeled images of a 2D cutout puppet "
                "rig: a rest-pose still, plus one motion image per action."}]
    for label in order:
        frames, ok = images[label]
        if label == "rest":
            note = " (rest pose, single still)"
        elif ok:
            note = (" (filmstrip: 4 frames left→right at ~15/40/65/90% of the action's "
                     "motion -- judge the MOTION: does it read as the named action? is the "
                     "arc smooth across the strip? clipping at any phase? silhouette clarity "
                     "throughout?)")
        else:
            note = " (ffmpeg tiling unavailable -- single mid-action frame only, no motion arc)"
        content.append({"type": "text", "text": f"[{label}]" + note})
        for img in frames:
            content.append({"type": "image_url", "image_url": {"url": img}})
    system = (
        "You are an animation supervisor reviewing a 2D cutout puppet rig. The rest-pose "
        "image is a single still. Each action image is normally a filmstrip of 4 frames "
        "left→right at ~15/40/65/90% of that action's duration -- judge the MOTION across "
        "the strip, not just a single pose: does it read as the named action? is the arc "
        "smooth across the four phases? any clipping/overlap at any phase? is the silhouette "
        "clear throughout? (A handful of actions may arrive as a single mid-action frame "
        "instead, when filmstrip tiling wasn't available -- judge those as a static pose.) "
        "Then give overall notes on the rig. Return strict json only, no prose: "
        '{"actions":{"<name>":{"reads":true|false,"issues":["..."]}},'
        '"overall":["..."],"suggestions":["concrete manifest keyframe or SVG tweaks"]}.'
    )
    messages = [{"role": "system", "content": system}, {"role": "user", "content": content}]
    try:
        raw = _openai_chat(messages, response_format={"type": "json_object"}, temperature=0.4)
    except _OpenAIError as exc:
        return {"status": "error", "error": str(exc)}
    try:
        verdict = json.loads(raw)
    except json.JSONDecodeError:
        return {"status": "error", "error": "vision verdict was not valid json", "raw": raw[:500]}
    return {"status": "ok", "character": name, "images_captured": order, "strip": strip_ok,
            "verdict": verdict}

# ---------------------------------------------------------------- dispatch

def POST(request):
    if request.get("review_character"):
        return _audition(request)

    prompt = str(request.get("prompt", "")).strip()
    if not prompt:
        return {"status": "error", "error": "prompt required"}
    review = bool(request.get("review", False))
    perform = bool(request.get("perform", True)) or review

    try:
        cap = _capabilities()
    except Exception as exc:
        return {"status": "error", "error": f"capabilities fetch failed: {str(exc)[:200]}"}
    try:
        script, errors = _compose(prompt, cap)
    except _OpenAIError as exc:
        return {"status": "error", "error": str(exc)}
    if errors:
        _logger.warning("script failed lint after retry", errors=errors[:5])
        return {"status": "error", "errors": errors, "script": script}

    main_char = _main_character(script, cap)
    performed = False
    if perform:
        try:
            _perform(script, main_char)
            performed = True
        except Exception as exc:
            _logger.warning("perform failed", error=str(exc)[:200])

    _logger.info("script composed", chars=len(script), performed=performed, review=review)
    result = {"status": "ok", "script": script, "lint": "clean", "performed": performed, "model": MODEL}
    if not review:
        return result

    critique = _review_show(script, main_char)
    if critique.get("status") == "unavailable":
        result["review"] = f"unavailable: {critique.get('reason', 'unknown')}"
        return result
    result["review"] = critique
    revised = critique.get("revised_script")
    if revised and request.get("apply_revision"):
        try:
            _perform(revised, main_char)
            result["revision_performed"] = True
        except Exception as exc:
            result["revision_performed"] = False
            result["revision_error"] = str(exc)[:200]
    return result

def GET(request):
    return {
        "status": "ok",
        "model": MODEL,
        "puppet_base": BASE,
        "usage": {
            "compose": 'POST {"prompt":"...", "perform":true, "review":false} '
                       "-> writes+lints+performs a screenplay",
            "review": 'POST {"prompt":"...", "review":true, "apply_revision":false} '
                      "-> compose+perform, then a vision critique of one 3-panel "
                      "early/mid/late filmstrip",
            "audition": 'POST {"review_character":"<name>", "actions":[...]} '
                        "-> vision review of a character's action filmstrips (motion, "
                        "not just a single pose)",
        },
    }
