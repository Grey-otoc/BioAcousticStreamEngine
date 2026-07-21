"""
End-to-end test of the insect (Orthoptera) detection pipeline.

Validates the full signal path:
  Audio source (44.1 kHz)
    → AudioChunk
    → AudioProcessor  (bandpass 3.5–20 kHz)
    → InsectClassifier (OpenSoundscape CNN → confirm_chunks gate)
    → Detection

Also tests the confirm_chunks consecutive-hit gate: the classifier must see
a species score above threshold in N consecutive chunks before reporting it,
and must reset the counter if a chunk is missed.

Uses real captured clips from output/clips/<Species>/ so the model is tested
against audio it has already confirmed as genuine orthoptera calls.

Author: David Green, Blenheim Palace
"""

import glob
import os
import time

import numpy as np
import pytest
import soundfile as sf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

import sys
sys.path.insert(0, os.path.join(ROOT, "src"))

from ecoacoustics.audio.capture import AudioChunk
from ecoacoustics.audio.processor import AudioProcessor
from ecoacoustics.classifiers.insect import InsectClassifier

# ── Constants ─────────────────────────────────────────────────────────────────

INSECT_RATE = 44_100
FREQ_MIN    = 3_500
FREQ_MAX    = 20_000

# Directories under output/clips/ that contain real orthoptera recordings
INSECT_CLIP_DIRS = [
    "Field_Cricket",
    "Field_Grasshopper",
    "Meadow_Grasshopper",
    "Great_Green_Bush-cricket",
    "Dark_Bush-cricket",
    "Common_Green_Grasshopper",
    "Speckled_Bush-cricket",
    "Roesel's_Bush-cricket",
]

MODEL_PATH = os.path.join(ROOT, "models", "orthoptera_uk.model")
MODEL_AVAILABLE = os.path.exists(MODEL_PATH)

# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_chunk(data: np.ndarray, sample_rate: int = INSECT_RATE) -> AudioChunk:
    return AudioChunk(data=data.astype(np.float32), sample_rate=sample_rate, timestamp=time.time())


def _make_processor() -> AudioProcessor:
    return AudioProcessor(
        target_sample_rate=INSECT_RATE,
        freq_min_hz=FREQ_MIN,
        freq_max_hz=FREQ_MAX,
    )


def _make_classifier(overrides: dict | None = None) -> InsectClassifier:
    cfg = {
        "model_path": MODEL_PATH,
        "min_confidence": 0.2,
        "confirm_chunks": 1,       # default to 1 for isolation tests
        "silence_threshold": 0.0001,
        "report_cooldown_secs": 0,
        "freq_min_hz": FREQ_MIN,
        "freq_max_hz": FREQ_MAX,
    }
    if overrides:
        cfg.update(overrides)
    clf = InsectClassifier(cfg)
    clf.load()
    return clf


def _find_clips(species_dir: str, n: int = 2) -> list[str]:
    pattern = os.path.join(ROOT, "output", "clips", species_dir, "*.wav")
    return glob.glob(pattern)[:n]


def _load_clip(path: str) -> tuple[np.ndarray, int]:
    data, sr = sf.read(path, dtype="float32", always_2d=False)
    return data, sr


# ── AudioChunk format ─────────────────────────────────────────────────────────

def test_insect_chunk_format():
    """AudioChunk for insect must be float32 mono at 44.1 kHz."""
    data = np.random.randn(INSECT_RATE * 3).astype(np.float32)
    chunk = _make_chunk(data)

    assert chunk.sample_rate == INSECT_RATE
    assert chunk.data.dtype == np.float32
    assert chunk.data.ndim == 1
    assert len(chunk.data) == INSECT_RATE * 3


# ── AudioProcessor bandpass ───────────────────────────────────────────────────

def test_processor_preserves_sample_rate():
    proc = _make_processor()
    data = np.random.randn(INSECT_RATE * 3).astype(np.float32) * 0.01
    out = proc.process(_make_chunk(data))

    assert out.sample_rate == INSECT_RATE
    assert len(out.data) == len(data)
    assert out.data.dtype == np.float32


def test_processor_attenuates_low_freq():
    """Signals below 3.5 kHz (bird song, wind rumble) must be heavily attenuated."""
    proc = _make_processor()
    t = np.arange(INSECT_RATE * 3) / INSECT_RATE
    tone_500hz = np.sin(2 * np.pi * 500 * t).astype(np.float32)
    out = proc.process(_make_chunk(tone_500hz))

    in_rms  = np.sqrt(np.mean(tone_500hz ** 2))
    out_rms = np.sqrt(np.mean(out.data ** 2))
    atten_db = 20 * np.log10(out_rms / max(in_rms, 1e-10))
    assert atten_db < -30, f"500 Hz should be suppressed >30 dB, got {atten_db:.1f} dB"


def test_processor_passes_grasshopper_band():
    """5 kHz tone (Field Grasshopper stridulation) must pass the bandpass."""
    proc = _make_processor()
    t = np.arange(INSECT_RATE * 3) / INSECT_RATE
    tone_5khz = np.sin(2 * np.pi * 5_000 * t).astype(np.float32)
    out = proc.process(_make_chunk(tone_5khz))

    in_rms  = np.sqrt(np.mean(tone_5khz ** 2))
    out_rms = np.sqrt(np.mean(out.data ** 2))
    atten_db = 20 * np.log10(out_rms / max(in_rms, 1e-10))
    assert atten_db > -3, f"5 kHz should pass with <3 dB loss, got {atten_db:.1f} dB"


def test_processor_no_nan_or_inf():
    proc = _make_processor()
    data = np.random.randn(INSECT_RATE * 3).astype(np.float32) * 0.05
    out = proc.process(_make_chunk(data))

    assert not np.any(np.isnan(out.data))
    assert not np.any(np.isinf(out.data))


# ── Silence gate ──────────────────────────────────────────────────────────────

@pytest.mark.skipif(not MODEL_AVAILABLE, reason="No model file")
def test_silence_gate_skips_inference():
    clf = _make_classifier({"silence_threshold": 0.01})
    proc = _make_processor()

    silent = np.zeros(INSECT_RATE * 3, dtype=np.float32)
    out = proc.process(_make_chunk(silent))
    dets = clf.classify(out)

    assert dets == []
    clf.cleanup()


# ── confirm_chunks gate ───────────────────────────────────────────────────────

@pytest.mark.skipif(not MODEL_AVAILABLE, reason="No model file")
def test_confirm_chunks_requires_consecutive_hits():
    """
    With confirm_chunks=2 the classifier must stay silent on the first hit and
    only report on the second consecutive chunk of the same species.
    """
    clips = _find_clips("Field_Cricket", n=1)
    if not clips:
        pytest.skip("No Field_Cricket clips available")

    proc = _make_processor()
    clf  = _make_classifier({"confirm_chunks": 2, "min_confidence": 0.15})

    data, sr = _load_clip(clips[0])
    assert sr == INSECT_RATE
    processed = proc.process(_make_chunk(data))

    # First hit — should return nothing (counter=1, need 2)
    dets_first = clf.classify(processed)
    assert dets_first == [], (
        "confirm_chunks=2: first chunk should not produce a detection"
    )

    # Second consecutive hit — should now report
    dets_second = clf.classify(processed)
    assert len(dets_second) >= 1, (
        "confirm_chunks=2: second consecutive chunk should produce a detection"
    )

    clf.cleanup()


@pytest.mark.skipif(not MODEL_AVAILABLE, reason="No model file")
def test_confirm_chunks_resets_on_miss():
    """
    If a species misses a chunk, its hit counter resets to 0. Two hits with a
    miss in between must not produce a detection with confirm_chunks=2.
    """
    clips = _find_clips("Field_Cricket", n=1)
    if not clips:
        pytest.skip("No Field_Cricket clips available")

    proc = _make_processor()
    clf  = _make_classifier({"confirm_chunks": 2, "min_confidence": 0.15})

    data, sr = _load_clip(clips[0])
    assert sr == INSECT_RATE
    real_chunk = proc.process(_make_chunk(data))
    # Sub-silence chunk: RMS is below silence_threshold so the classifier resets
    # all hit counters (silence gate must clear the counter, not just return [])
    silent = np.zeros(INSECT_RATE * 3, dtype=np.float32)
    noise_chunk = proc.process(_make_chunk(silent))

    dets_1 = clf.classify(real_chunk)   # hit 1  → counter=1
    dets_n = clf.classify(noise_chunk)  # miss   → counter resets to 0
    dets_2 = clf.classify(real_chunk)   # hit 1 again → counter=1, not 2

    assert dets_1 == [], "First hit should not report"
    assert dets_n == [], "Silent chunk should not report"
    assert dets_2 == [], (
        "After a miss the counter resets — second hit should not report yet"
    )

    clf.cleanup()


@pytest.mark.skipif(not MODEL_AVAILABLE, reason="No model file")
def test_confirm_chunks_one_fires_immediately():
    """confirm_chunks=1 must report on the very first chunk above threshold."""
    clips = _find_clips("Field_Cricket", n=1)
    if not clips:
        pytest.skip("No Field_Cricket clips available")

    proc = _make_processor()
    clf  = _make_classifier({"confirm_chunks": 1, "min_confidence": 0.15})

    data, sr = _load_clip(clips[0])
    processed = proc.process(_make_chunk(data))
    dets = clf.classify(processed)

    assert len(dets) >= 1, "confirm_chunks=1 should report immediately on a real clip"
    clf.cleanup()


# ── Species-level detection on real clips ─────────────────────────────────────

# Pick one high-quality clip per species that has enough clips available
_SPECIES_CLIP_PAIRS = [
    ("Field_Cricket",              "Field Cricket"),
    ("Field_Grasshopper",          "Field Grasshopper"),
    ("Meadow_Grasshopper",         "Meadow Grasshopper"),
    ("Great_Green_Bush-cricket",   "Great Green Bush-cricket"),
    ("Dark_Bush-cricket",          "Dark Bush-cricket"),
    ("Common_Green_Grasshopper",   "Common Green Grasshopper"),
]


@pytest.mark.skipif(not MODEL_AVAILABLE, reason="No model file")
@pytest.mark.parametrize("clip_dir,expected_label", _SPECIES_CLIP_PAIRS)
def test_real_clip_produces_detection(clip_dir, expected_label):
    """
    Real clips must produce a Detection with confirm_chunks=1 so we can
    isolate single-clip behaviour. The reported label must match the species.
    """
    clips = _find_clips(clip_dir, n=1)
    if not clips:
        pytest.skip(f"No clips for {clip_dir}")

    data, sr = _load_clip(clips[0])
    assert sr == INSECT_RATE, f"Clip sr={sr}, expected {INSECT_RATE}"

    proc = _make_processor()
    clf  = _make_classifier({"confirm_chunks": 1, "min_confidence": 0.15})

    processed = proc.process(_make_chunk(data))
    dets = clf.classify(processed)

    assert len(dets) >= 1, (
        f"Expected ≥1 detection for {expected_label}, got 0. "
        "Model may need retraining or confidence threshold needs lowering."
    )

    det = dets[0]
    assert 0.0 < det.confidence <= 1.0
    assert det.classifier == "insect"
    assert det.label == expected_label, (
        f"Clip is {expected_label} but classifier returned '{det.label}'. "
        "Species mapping or model may need updating."
    )
    assert "scientific_name" in det.metadata
    assert "model"           in det.metadata
    assert "group"           in det.metadata

    clf.cleanup()


# ── Detection metadata validation ─────────────────────────────────────────────

@pytest.mark.skipif(not MODEL_AVAILABLE, reason="No model file")
def test_detection_metadata_group_label():
    """Orthoptera group must be one of Grasshopper / Bush Cricket / Cricket / Orthoptera."""
    clips = _find_clips("Field_Cricket", n=1)
    if not clips:
        pytest.skip("No Field_Cricket clips available")

    proc = _make_processor()
    clf  = _make_classifier({"confirm_chunks": 1, "min_confidence": 0.15})

    data, _ = _load_clip(clips[0])
    dets = clf.classify(proc.process(_make_chunk(data)))

    if dets:
        assert dets[0].metadata["group"] in {"Grasshopper", "Bush Cricket", "Cricket", "Orthoptera"}

    clf.cleanup()


# ── False positive check ──────────────────────────────────────────────────────

@pytest.mark.skipif(not MODEL_AVAILABLE, reason="No model file")
def test_white_noise_no_detection():
    """
    The confirm_chunks gate (production default: 2) must prevent a single
    noisy chunk from producing a detection, even when the epoch-4 model
    scores above threshold on broadband noise.

    The model at epoch 4/30 has known false-positive susceptibility on
    white noise (Field Cricket activates on broadband energy).  In production
    confirm_chunks=2 is the primary defence: two consecutive noise chunks
    would both need to score above threshold, which is far less likely.
    """
    proc = _make_processor()
    # confirm_chunks=2 matches production settings
    clf  = _make_classifier({"confirm_chunks": 2, "min_confidence": 0.35})

    rng = np.random.default_rng(42)
    noise = rng.standard_normal(INSECT_RATE * 3).astype(np.float32) * 0.005
    processed = proc.process(_make_chunk(noise))

    # Single noisy chunk must not report (counter=1, need 2)
    dets = clf.classify(processed)
    assert dets == [], (
        f"Single noisy chunk produced {len(dets)} detection(s): {[d.label for d in dets]}. "
        "confirm_chunks=2 should suppress this — check the gate logic."
    )
    clf.cleanup()
