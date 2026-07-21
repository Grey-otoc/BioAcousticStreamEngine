"""
End-to-end test of the bird species detection pipeline as it runs from a microphone.

Validates the full signal path:
  Microphone (48 kHz float32 PCM)
    → AudioChunk
    → AudioProcessor  (no bandpass — BirdNET uses the full spectrum)
    → BirdClassifier  (→ /dev/shm WAV → BirdNET TFLite at 48 kHz)
    → Detection

Uses real captured clips from output/clips/<Species>/ so BirdNET is tested
against audio it has already confirmed as genuine bird calls.

Author: David Green, Blenheim Palace
"""

import glob
import os
import time
import warnings

import numpy as np
import pytest
import soundfile as sf

# Resolve project root so tests run from any cwd
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

import sys
sys.path.insert(0, os.path.join(ROOT, "src"))

from ecoacoustics.audio.capture import AudioChunk
from ecoacoustics.audio.processor import AudioProcessor
from ecoacoustics.classifiers.bird import BirdClassifier

# ── Constants ─────────────────────────────────────────────────────────────────

BIRD_RATE = 48_000  # BirdNET requires 48 kHz

# Top 4 species by clip count from output/clips/: 100, 100, 100, 93
BIRD_CLIP_DIRS = [
    "Eurasian_Blue_Tit",
    "Eurasian_Blackbird",
    "Common_Swift",
    "Common_Chiffchaff",
]

# The five BirdNET noise pseudo-classes that should always be suppressed
NOISE_CLASSES = {"Human vocal", "Engine", "Wind", "Rain", "Noise"}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _one_clip_per_species() -> list[str]:
    """Return the first (alphabetically sorted) clip for each of the 4 species."""
    clips = []
    for d in BIRD_CLIP_DIRS:
        pattern = os.path.join(ROOT, "output", "clips", d, "*.wav")
        found = sorted(glob.glob(pattern))
        if found:
            clips.append(found[0])
    return clips


def _make_chunk(data: np.ndarray, sr: int = BIRD_RATE) -> AudioChunk:
    return AudioChunk(data=data.astype(np.float32), sample_rate=sr, timestamp=time.time())


def _make_processor() -> AudioProcessor:
    """Bird processor: no bandpass, no resampling — BirdNET uses full spectrum at 48 kHz."""
    return AudioProcessor(
        target_sample_rate=BIRD_RATE,
        freq_min_hz=None,
        freq_max_hz=None,
    )


def _make_classifier(overrides: dict | None = None) -> BirdClassifier:
    cfg = {
        "min_confidence": 0.1,
        "silence_threshold": 0.0001,  # very low so test clips are never skipped
    }
    if overrides:
        cfg.update(overrides)
    clf = BirdClassifier(cfg)
    clf.load()
    return clf


# ── AudioChunk format validation ──────────────────────────────────────────────

def test_chunk_format():
    """AudioChunk from a bird microphone must be float32 mono at 48 kHz."""
    data = np.random.randn(BIRD_RATE * 3).astype(np.float32)
    chunk = _make_chunk(data, BIRD_RATE)

    assert chunk.sample_rate == BIRD_RATE,       "Sample rate must be 48 kHz"
    assert chunk.data.dtype == np.float32,        "Microphone delivers float32 PCM"
    assert chunk.data.ndim == 1,                  "Must be mono (1-D)"
    assert len(chunk.data) == BIRD_RATE * 3,      "3-second chunk"


# ── AudioProcessor passthrough validation ─────────────────────────────────────

def test_processor_no_bandpass_applied():
    """AudioProcessor with freq_min=None, freq_max=None must preserve signal RMS within 1%."""
    proc = _make_processor()
    rng = np.random.default_rng(0)
    data = rng.standard_normal(BIRD_RATE * 3).astype(np.float32) * 0.05
    chunk = _make_chunk(data, BIRD_RATE)
    out = proc.process(chunk)

    in_rms  = np.sqrt(np.mean(data ** 2))
    out_rms = np.sqrt(np.mean(out.data ** 2))
    ratio = abs(out_rms - in_rms) / in_rms

    assert out.sample_rate == BIRD_RATE, "Sample rate must be unchanged"
    assert len(out.data) == len(data),    "Length must be unchanged"
    assert out.data.dtype == np.float32,  "Output must remain float32"
    assert ratio < 0.01, (
        f"RMS changed by {ratio:.2%} — passthrough must preserve amplitude within 1%"
    )


def test_processor_no_nan_or_inf():
    """Processor output must never contain NaN or Inf (numerical stability check)."""
    proc = _make_processor()
    rng = np.random.default_rng(1)
    data = rng.standard_normal(BIRD_RATE * 3).astype(np.float32) * 0.05
    out = proc.process(_make_chunk(data, BIRD_RATE))

    assert not np.any(np.isnan(out.data)), "NaN in processor output"
    assert not np.any(np.isinf(out.data)), "Inf in processor output"


# ── Silence gate ──────────────────────────────────────────────────────────────

def test_silence_gate_skips_inference():
    """Near-silent chunks must return [] without invoking BirdNET."""
    clf = _make_classifier({"silence_threshold": 0.01})

    silent = np.zeros(BIRD_RATE * 3, dtype=np.float32)
    dets = clf.classify(_make_chunk(silent))

    assert dets == [], "Silent chunk must produce no detections"
    clf.cleanup()


# ── Exclude-set validation ────────────────────────────────────────────────────

def test_exclude_species_filters_noise_classes():
    """Default _exclude set must contain all 5 BirdNET noise pseudo-classes.

    No model load required — _exclude is populated in __init__ from config.
    """
    clf = BirdClassifier({})
    assert NOISE_CLASSES.issubset(clf._exclude), (
        f"Missing noise classes in _exclude: {NOISE_CLASSES - clf._exclude}"
    )


# ── Temp WAV format ───────────────────────────────────────────────────────────

def test_tmp_wav_written_at_48khz():
    """After classify(), _tmp_path must exist and be a mono 48 kHz WAV file."""
    clf = _make_classifier()

    rng = np.random.default_rng(2)
    data = rng.standard_normal(BIRD_RATE * 3).astype(np.float32) * 0.05
    chunk = _make_chunk(data)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        clf.classify(chunk)

    assert clf._tmp_path is not None,          "Temp file path not set after classify()"
    assert os.path.exists(clf._tmp_path),      f"Temp WAV not found at {clf._tmp_path}"

    info = sf.info(clf._tmp_path)
    assert info.samplerate == BIRD_RATE, (
        f"Temp WAV written at {info.samplerate} Hz, expected {BIRD_RATE}. "
        "BirdNET will time-stretch the audio if the rate is wrong."
    )
    assert info.channels == 1, "Temp WAV must be mono"

    clf.cleanup()


# ── End-to-end detection on real bird clips ───────────────────────────────────

@pytest.mark.parametrize("clip_path", _one_clip_per_species())
def test_real_clip_produces_detection(clip_path):
    """
    Real bird clips at 48 kHz must produce at least one Detection with a
    plausible species label, confidence in (0, 1], classifier == 'bird',
    and scientific_name in metadata.

    No lat/lon filtering so BirdNET does not range-filter out any species.
    min_confidence=0.1 gives headroom for model uncertainty on short clips.
    """
    data, sr = sf.read(clip_path, dtype="float32", always_2d=False)

    assert sr == BIRD_RATE, (
        f"Clip {os.path.basename(clip_path)} has sr={sr}, expected {BIRD_RATE}. "
        "Clips must be saved at BirdNET's 48 kHz input rate."
    )
    assert data.ndim == 1, "Clips must be mono"

    clf = _make_classifier()
    chunk = _make_chunk(data)
    dets = clf.classify(chunk)

    species_name = os.path.basename(os.path.dirname(clip_path)).replace("_", " ")
    assert len(dets) >= 1, (
        f"Expected ≥1 detection for {species_name} "
        f"({os.path.basename(clip_path)}), got 0. "
        "Check that min_confidence is not too high for this clip."
    )

    det = dets[0]
    assert 0.0 < det.confidence <= 1.0,       f"Confidence out of range: {det.confidence}"
    assert det.classifier == "bird",            f"Wrong classifier label: {det.classifier}"
    assert det.label,                           "Detection label must not be empty"
    assert "scientific_name" in det.metadata,   "scientific_name missing from metadata"

    clf.cleanup()


# ── Noise produces no detection (false positive check) ────────────────────────

def test_white_noise_no_detection():
    """
    Gaussian noise must not produce high-confidence bird detections.
    min_confidence=0.7 is the threshold — BirdNET can return low-confidence
    hits on unstructured noise, but should not reach 0.7 on random noise.
    """
    clf = _make_classifier({"min_confidence": 0.7})

    rng = np.random.default_rng(42)
    noise = rng.standard_normal(BIRD_RATE * 3).astype(np.float32) * 0.002
    dets = clf.classify(_make_chunk(noise))

    assert dets == [], (
        f"White noise produced {len(dets)} high-confidence detections: {[d.label for d in dets]}. "
        "False positive at ≥0.7 confidence — check min_confidence and silence_threshold."
    )
    clf.cleanup()


# ── Cleanup removes temp file ─────────────────────────────────────────────────

def test_cleanup_removes_tmp_file():
    """cleanup() must delete the /dev/shm temp WAV so no files are left behind."""
    clf = _make_classifier()

    # Write the temp file by classifying a non-silent chunk
    rng = np.random.default_rng(3)
    data = rng.standard_normal(BIRD_RATE * 3).astype(np.float32) * 0.05
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        clf.classify(_make_chunk(data))

    tmp = clf._tmp_path
    assert tmp is not None,         "Temp file path not set after classify()"
    assert os.path.exists(tmp),     f"Temp WAV not found at {tmp} before cleanup"

    clf.cleanup()
    assert not os.path.exists(tmp), f"cleanup() did not delete temp WAV at {tmp}"
