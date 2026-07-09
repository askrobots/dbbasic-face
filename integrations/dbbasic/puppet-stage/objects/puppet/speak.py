"""Puppet Stage speech object: text -> WAV -> Rhubarb viseme timeline.

POST {"text": ..., "engine": "say"|"espeak", "voice": ..., "rate": ...}
  -> {"status": "ok", "audio": "data:audio/wav;base64,...",
      "timeline": [{start, end, value}, ...] | null,
      "duration": seconds, "text": ...}

GET ?voices=1&engine=say|espeak -> {"status": "ok", "voices": [...]}

Audio returns inline as a data URI so no file serving is needed. The viseme
timeline uses Rhubarb Lip Sync (binary located via $RHUBARB_PATH or $PATH);
without it, "timeline" is null and the stage falls back to amplitude sync.
Requires ffmpeg, plus macOS `say` and/or `espeak`.
"""

import base64
import json
import os
import re
import shutil
import subprocess
import tempfile


def _run(cmd, timeout=90):
    proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed: {proc.stderr.decode(errors='replace')[:400]}")
    return proc.stdout


def _rhubarb():
    path = os.environ.get("RHUBARB_PATH") or shutil.which("rhubarb")
    return path if path and os.path.exists(path) else None


def _render_tts(text, engine, voice, rate, workdir):
    raw = os.path.join(workdir, "raw.aiff" if engine == "say" else "raw.wav")
    if engine == "say":
        cmd = ["say", "-o", raw]
        if voice:
            cmd += ["-v", voice]
        if rate:
            cmd += ["-r", str(int(rate))]
        cmd.append(text)
    else:
        cmd = ["espeak", "-w", raw]
        if voice:
            cmd += ["-v", voice]
        if rate:
            cmd += ["-s", str(int(rate))]
        cmd.append(text)
    _run(cmd)
    wav = os.path.join(workdir, "speech.wav")
    _run(["ffmpeg", "-y", "-loglevel", "error", "-i", raw,
          "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav])
    return wav


def POST(request):
    text = str(request.get("text", "")).strip()
    if not text:
        return {"status": "error", "error": "text required"}
    engine = "espeak" if request.get("engine") == "espeak" else "say"
    voice = str(request.get("voice", "") or "")
    try:
        rate = int(request.get("rate") or 0)
    except (TypeError, ValueError):
        rate = 0

    try:
        with tempfile.TemporaryDirectory() as workdir:
            wav = _render_tts(text, engine, voice, rate, workdir)

            timeline = None
            duration = 0.0
            rhubarb = _rhubarb()
            if rhubarb:
                dialog = os.path.join(workdir, "dialog.txt")
                with open(dialog, "w") as fh:
                    fh.write(text)
                try:
                    out = _run([rhubarb, "-f", "json", "--extendedShapes", "GHX",
                                "--dialogFile", dialog, wav])
                    parsed = json.loads(out)
                    timeline = parsed["mouthCues"]
                    duration = parsed["metadata"]["duration"]
                except Exception as exc:  # rhubarb is best-effort
                    _logger.warning("rhubarb failed", error=str(exc)[:200])
            if not duration:
                probe = _run(["ffprobe", "-v", "error", "-show_entries",
                              "format=duration", "-of", "csv=p=0", wav])
                duration = float(probe.decode().strip() or 0)

            with open(wav, "rb") as fh:
                audio_b64 = base64.b64encode(fh.read()).decode()
    except Exception as exc:
        _logger.error("speech render failed", error=str(exc)[:300])
        return {"status": "error", "error": str(exc)[:300]}

    _logger.info("speech rendered", engine=engine, chars=len(text),
                 duration=round(duration, 2), visemes=len(timeline or []))
    return {
        "status": "ok",
        "audio": "data:audio/wav;base64," + audio_b64,
        "timeline": timeline,
        "duration": duration,
        "text": text,
    }


def GET(request):
    if not request.get("voices"):
        return {"status": "ok",
                "usage": "POST {text, engine, voice, rate} or GET ?voices=1&engine=say"}
    engine = "espeak" if request.get("engine") == "espeak" else "say"
    try:
        if engine == "espeak":
            out = _run(["espeak", "--voices"]).decode(errors="replace")
            voices = [line.split()[3] for line in out.splitlines()[1:] if len(line.split()) > 3]
        else:
            out = _run(["say", "-v", "?"]).decode(errors="replace")
            voices = [m.group(1).strip()
                      for m in re.finditer(r"^(.+?)\s{2,}(en[_-]\w+)", out, re.M)]
    except Exception as exc:
        return {"status": "error", "error": str(exc)[:200]}
    return {"status": "ok", "voices": voices}
