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
  point in the timeline, then one vision call over all 3 frames + the script
  for a critique. apply_revision also performs the model's revised_script.
POST {"review_character": "<name>", "actions": [optional subset]}
  AUDITION: fires each action, screenshots mid-pose (spawn Firefox holding
  ?shot&d=3500, fire the cue ~2.2s in so the load-hold captures it mid-
  motion), plus one rest pose, then one vision call for an animation
  critique.
GET -> {"status":"ok","usage": {...}}

Config (env): PUPPET_BASE (default http://127.0.0.1:3123), OPENAI_MODEL
(default gpt-4o-mini), OPENAI_API_KEY or OPENAI_KEY_FILE (path to a
.env-style file with an OPENAI_API_KEY=... line). Key is never logged or
returned. Zero third-party deps: urllib.request against api.openai.com,
subprocess for headless Firefox. Character/asset lists are fetched live from
PUPPET_BASE and cached in-module for 60s so the model can't invent a name.
Firefox/screenshot failures degrade review/audition (skip vision) instead of
failing the whole request.
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
MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox"
OPENAI_URL = "https://api.openai.com/v1/chat/completions"

GRAMMAR = """SCREENPLAY GRAMMAR (plain text file, one or more directions per bracket line)
  # comment                          ignored
  Hello there.                       plain line = spoken by the main/current character
  left: Hi!                          "id: text" = spoken by that frame/actor id
  (wave) Hi!                         (action) prefix = fires an action while the line is spoken
  [wave]                             a line of one-or-more space-joined [direction] groups
Directions (inside [...]):
  walk to N | enter from left|right | exit left|right   move/enter/exit (N = % of stage width)
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
  remove <id>                         remove a placed actor
  wear <target> <prop> [scale:<n>] [anchor:<name>]   pin a prop to a character/actor (anchor default head)
  unwear <target> [anchor]
  music <id> | music off              background loop
  sfx <id>                            one-shot sound effect
  clear                               wipe placed actors/worn props/content/overlays
  [<frame-or-actor-id> <direction>]   route any direction above at a frame/actor, e.g. [left wave] [hoop1 spin]
Rules: multi-character scenes need [layout split] + [frame left character:X]
[frame right character:Y] BEFORE using "left:"/"right:" as speaker prefixes —
a bare character name is never itself a valid speaker prefix.
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
            if target not in frame_ids and target not in actor_ids:
                errors.append(f"line {lineno}: unknown wear target '{target}'")
            if prop not in prop_ids:
                errors.append(f"line {lineno}: unknown prop '{prop}' in [wear]")
            return
        if head == "unwear":
            if not rest:
                errors.append(f"line {lineno}: [unwear] needs a target"); return
            if rest[0] not in frame_ids and rest[0] not in actor_ids:
                errors.append(f"line {lineno}: unknown unwear target '{rest[0]}'")
            return
        if head in _SIMPLE_DIRECTIONS:
            return
        if (head in frame_ids or head in actor_ids) and rest:
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
                check(m.group(1), lineno)
            continue
        if "[" in line or "]" in line:
            errors.append(f"line {lineno}: stray brackets outside a direction-only line: {line[:60]}")
            continue
        text = line
        m = _SPEAKER.match(text)
        if m:
            label = m.group(1)
            if label in frame_ids or label in actor_ids:
                text = m.group(2)
            elif label in cast_names:
                errors.append(
                    f"line {lineno}: '{label}:' used as speaker but not set up via "
                    f"[frame ... character:{label}] or [place {label} ...]")
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

def _shot_data_uri(url, timeout):
    if not os.path.exists(FIREFOX):
        raise RuntimeError(f"firefox not found at {FIREFOX}")
    profile = tempfile.mkdtemp(prefix="ffprof-")
    fd, out = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        subprocess.run(
            [FIREFOX, "--headless", "--new-instance", "--profile", profile,
             "--screenshot", out, "--window-size=1280,760", url],
            capture_output=True, timeout=timeout, check=True)
        if not os.path.exists(out) or os.path.getsize(out) == 0:
            raise RuntimeError("screenshot not produced")
        with open(out, "rb") as fh:
            raw = fh.read()
        return "data:image/png;base64," + base64.b64encode(raw).decode()
    finally:
        shutil.rmtree(profile, ignore_errors=True)
        try:
            os.remove(out)
        except OSError:
            pass

def _timed_action_shot(name, action):
    """Spawn firefox holding ?shot&d=3500, fire the action ~2.2s in, wait for
    the screenshot to land mid-motion. `action` None captures a rest pose."""
    if not os.path.exists(FIREFOX):
        raise RuntimeError(f"firefox not found at {FIREFOX}")
    profile = tempfile.mkdtemp(prefix="ffprof-")
    fd, out = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        proc = subprocess.Popen(
            [FIREFOX, "--headless", "--new-instance", "--profile", profile,
             "--screenshot", out, "--window-size=1280,760", f"{BASE}/?shot&d=3500"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(2.2)
        if action:
            _http_post(f"{BASE}/api/cue", {"type": "action", "name": action})
        proc.wait(timeout=20)
        if not os.path.exists(out) or os.path.getsize(out) == 0:
            raise RuntimeError("screenshot not produced")
        with open(out, "rb") as fh:
            raw = fh.read()
        return "data:image/png;base64," + base64.b64encode(raw).decode()
    finally:
        shutil.rmtree(profile, ignore_errors=True)
        try:
            os.remove(out)
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
    images = []
    for label, frac in zip(labels, (0.2, 0.5, 0.85)):
        d_ms = max(800, int(duration * 1000 * frac))
        try:
            _perform(script, main_char)
            img = _shot_data_uri(f"{BASE}/?shot&d={d_ms}", timeout=d_ms / 1000 + 20)
            images.append((label, img))
        except Exception as exc:
            return {"status": "unavailable", "reason": f"screenshot failed: {str(exc)[:200]}"}
    content = [{"type": "text", "text":
                f"Screenplay (estimated ~{int(duration)}s, performed 3 separate times; "
                f"each image is a screenshot from a different run at the labeled point "
                f"in the timeline):\n\n{script}"}]
    for label, img in images:
        content.append({"type": "text", "text": f"[{label}]"})
        content.append({"type": "image_url", "image_url": {"url": img}})
    system = (
        "You are reviewing a puppet-show performance for staging, timing, and "
        "continuity issues from screenshots taken early/middle/late in the show. "
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
    # cap total frames (rest pose + actions) at 6 per the vision-call image cap
    actions = [a for a in requested if a in entry["actions"]][:5]
    if not actions:
        return {"status": "error", "error": "no valid actions to audition"}

    images = {}
    try:
        _http_post(f"{BASE}/api/cue", {"type": "character", "name": name})
        images["rest"] = _timed_action_shot(name, None)
        for action in actions:
            images[action] = _timed_action_shot(name, action)
    except Exception as exc:
        if not images:
            return {"status": "error", "error": f"unavailable: {str(exc)[:200]}"}
        _logger.warning("audition shot failed partway", error=str(exc)[:200])

    order = ["rest"] + [a for a in actions if a in images]
    content = [{"type": "text", "text":
                f"Character: {name}. Judging {len(order)} labeled frames of a 2D cutout puppet rig."}]
    for label in order:
        content.append({"type": "text", "text": f"[{label}]" + (" (rest pose)" if label == "rest" else "")})
        content.append({"type": "image_url", "image_url": {"url": images[label]}})
    system = (
        "You are an animation supervisor reviewing a 2D cutout puppet rig. For each "
        "labeled action frame (compared against the rest pose) judge: does the pose "
        "read as that named action? any clipping/overlap issues? is the silhouette "
        "clear? Then give overall notes on the rig. Return strict json only, no prose: "
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
    return {"status": "ok", "character": name, "images_captured": order, "verdict": verdict}

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
                      "-> compose+perform, then a vision critique of 3 screenshots",
            "audition": 'POST {"review_character":"<name>", "actions":[...]} '
                        "-> vision review of a character's action poses",
        },
    }
