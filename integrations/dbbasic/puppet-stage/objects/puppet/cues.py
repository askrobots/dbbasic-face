"""Puppet Stage cue queue: the direction bus, polled by open stages.

POST any cue object, e.g.
  {"type": "say-text", "text": "Hello!", "engine": "say", "voice": "Samantha"}
  {"type": "action", "name": "wave"}
  {"type": "walk", "x": 75}
  {"type": "view", "mode": "face"}
  -> {"status": "ok", "seq": N}

GET ?since=N  -> {"status": "ok", "seq": latest, "cues": [cues after N]}
GET ?tail=1   -> {"status": "ok", "seq": latest, "cues": []}   (join live)

This is the external integration point: anything that can POST JSON can
direct every open stage. The queue keeps only the most recent cues — it is
a live bus, not a history. Note: appends are read-modify-write on object
state; simultaneous posts from many writers may drop cues (fine for a
direction bus, do not use as a ledger).
"""

import json

_KEEP = 60


def _load():
    seq = int(_state_manager.get("seq", 0))
    try:
        cues = json.loads(_state_manager.get("cues", "[]"))
    except (TypeError, ValueError):
        cues = []
    return seq, cues


def POST(request):
    cue = {k: v for k, v in request.items() if not k.startswith("_")}
    if not cue.get("type"):
        return {"status": "error", "error": "cue needs a type"}

    seq, cues = _load()
    seq += 1
    cue["seq"] = seq
    cues.append(cue)
    cues = cues[-_KEEP:]
    _state_manager.set("seq", seq)
    _state_manager.set("cues", json.dumps(cues))
    _logger.info("cue queued", type=cue["type"], seq=seq)
    return {"status": "ok", "seq": seq}


def GET(request):
    seq, cues = _load()
    if request.get("tail"):
        return {"status": "ok", "seq": seq, "cues": []}
    try:
        since = int(request.get("since", 0))
    except (TypeError, ValueError):
        since = 0
    return {"status": "ok", "seq": seq,
            "cues": [c for c in cues if c.get("seq", 0) > since]}
