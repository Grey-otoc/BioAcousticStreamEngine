"""
Test-file API — upload a WAV and run it through one or more classifiers.

POST /api/test/classify
  - file: WAV upload (multipart/form-data)
  - classifiers: repeated query param  e.g. ?classifiers=bird&classifiers=bat

Returns a JSON list of detections.  Each classifier is instantiated fresh,
run against the uploaded audio, then cleaned up — no persistent state.

Sample rates
------------
Each classifier has an expected sample rate. AudioProcessor resamples if the
uploaded file is at a different rate. Note that upsampling a 48 kHz recording
to 384 kHz does not create real ultrasonic content — bat results will be empty
for standard microphone recordings, which is the correct outcome.

Author: David Green, Blenheim Palace
"""

import io
import logging
import time
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
import yaml
from fastapi import APIRouter, File, HTTPException, Query, UploadFile

from ecoacoustics.audio.capture import AudioChunk
from ecoacoustics.audio.processor import AudioProcessor
from ecoacoustics.classifiers import REGISTRY

_log = logging.getLogger(__name__)
router = APIRouter()

_SETTINGS = Path("config/settings.yaml")

# Per-classifier AudioProcessor settings — matching production pipeline
_PROCESSOR_CONFIG: dict[str, dict[str, Any]] = {
    "bird":   {"target_sample_rate": 48_000,  "freq_min_hz": None,   "freq_max_hz": None},
    "bat":    {"target_sample_rate": 384_000, "freq_min_hz": 10_000, "freq_max_hz": 120_000},
    "bee":    {"target_sample_rate": 16_000,  "freq_min_hz": 80,     "freq_max_hz": 1_500},
    "insect": {"target_sample_rate": 44_100,  "freq_min_hz": 3_500,  "freq_max_hz": 20_000},
    "soil":   {"target_sample_rate": 22_050,  "freq_min_hz": 50,     "freq_max_hz": 2_000},
    "water":  {"target_sample_rate": 44_100,  "freq_min_hz": None,   "freq_max_hz": 8_000},
}


def _load_cfg() -> dict:
    if _SETTINGS.exists():
        with open(_SETTINGS) as f:
            return yaml.safe_load(f) or {}
    return {}


@router.post("/test/classify")
async def classify_file(
    file: UploadFile = File(...),
    classifiers: list[str] = Query(...),
) -> list[dict]:
    """
    Upload a WAV file and classify it with one or more classifiers.

    Returns a list of detection objects, each with:
      classifier, label, confidence, metadata
    """
    # ── Validate request ──────────────────────────────────────────────────────
    unknown = [c for c in classifiers if c not in REGISTRY]
    if unknown:
        raise HTTPException(400, f"Unknown classifier(s): {', '.join(unknown)}")

    wav_bytes = await file.read()
    if not wav_bytes:
        raise HTTPException(400, "Empty file upload")

    # ── Load audio ────────────────────────────────────────────────────────────
    try:
        data, sr = sf.read(io.BytesIO(wav_bytes), dtype="float32", always_2d=False)
    except Exception as exc:
        raise HTTPException(422, f"Could not read audio file: {exc}") from exc

    if data.ndim > 1:
        data = data[:, 0]  # take left channel if stereo

    cfg = _load_cfg()
    results: list[dict] = []

    for name in classifiers:
        proc_cfg = _PROCESSOR_CONFIG.get(name, {"target_sample_rate": sr})
        proc = AudioProcessor(**proc_cfg)

        clf_cfg = dict(cfg.get(name, {}))
        clf_cfg["report_cooldown_secs"] = 0  # never suppress results in test mode

        clf_class = REGISTRY[name]
        clf = clf_class(clf_cfg)

        try:
            clf.load()
            chunk = AudioChunk(data=data.copy(), sample_rate=sr, timestamp=time.time())
            processed = proc.process(chunk)
            dets = clf.classify(processed)
            for d in dets:
                results.append({
                    "classifier": d.classifier,
                    "label":      d.label,
                    "confidence": round(d.confidence, 4),
                    "metadata":   d.metadata,
                })
        except Exception as exc:
            _log.warning("test/classify error for %s: %s", name, exc)
            results.append({
                "classifier": name,
                "label":      None,
                "confidence": None,
                "metadata":   {"error": str(exc)},
            })
        finally:
            try:
                clf.cleanup()
            except Exception:
                pass

    return results
