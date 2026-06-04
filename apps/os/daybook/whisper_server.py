#!/usr/bin/env python3
"""
Persistent MLX-Whisper transcription sidecar.

Loads the Whisper model ONCE and keeps it resident, so each answer transcribes
in ~0.3s instead of paying a ~2GB model reload every time. Reads JSON request
lines from stdin ({"id","path"}) and writes JSON results to stdout
({"id","text"} or {"id","error"}). Emits {"type":"ready"} once warmed.

Run via: uv run --python 3.12 --with mlx-whisper python whisper_server.py
"""
import sys
import os
import json
import numpy as np
import mlx_whisper

MODEL = os.environ.get("WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    # Warm the model now (loads + caches it) so the first real answer is fast.
    try:
        mlx_whisper.transcribe(np.zeros(8000, dtype=np.float32), path_or_hf_repo=MODEL)
    except Exception:
        pass
    emit({"type": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid, path = req.get("id"), req.get("path")
        try:
            r = mlx_whisper.transcribe(path, path_or_hf_repo=MODEL)
            emit({"id": rid, "text": (r.get("text") or "").strip()})
        except Exception as e:  # noqa: BLE001
            emit({"id": rid, "error": str(e)})


if __name__ == "__main__":
    main()
