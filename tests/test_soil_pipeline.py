"""
End-to-end test of the soil acoustic index pipeline.

Validates the full signal path:
  AudioChunk (22050 Hz float32 PCM)
    → AudioProcessor  (bandpass 50–2000 Hz)
    → SoilClassifier  (SAI v2 = ndsi_01 × bio_rms_norm × transient_gate)
    → Detection

Uses real clips from output/clips/Soil_Activity_—_*/ and synthetic signals
to validate spectral discrimination, transient detection, and NDSI scoring.

Author: David Green, Blenheim Palace
"""

import glob
import os
import time

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
from ecoacoustics.classifiers.soil import SoilClassifier

# ── Constants ─────────────────────────────────────────────────────────────────

SR       = 22050   # SoilClassifier.sample_rate
FREQ_MIN = 50      # SoilClassifier.freq_min_hz
FREQ_MAX = 2000    # SoilClassifier.freq_max_hz
DURATION = 3       # seconds per synthetic chunk


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_chunk(data: np.ndarray) -> AudioChunk:
    return AudioChunk(data=data.astype(np.float32), sample_rate=SR, timestamp=time.time())


def _make_processor() -> AudioProcessor:
    return AudioProcessor(
        target_sample_rate=SR,
        freq_min_hz=FREQ_MIN,
        freq_max_hz=FREQ_MAX,
    )


def _make_classifier(overrides: dict | None = None) -> SoilClassifier:
    cfg: dict = {"min_confidence": 0.0}
    if overrides:
        cfg.update(overrides)
    return SoilClassifier(cfg)


def _find_soil_clips(subdir: str, n: int = 3) -> list[str]:
    """Return up to n real clips from the named output sub-directory."""
    pattern = os.path.join(ROOT, "output", "clips", subdir, "*.wav")
    return glob.glob(pattern)[:n]


def _make_bursty_bio_signal(rng: np.random.Generator) -> np.ndarray:
    """Twenty 30 ms bursts of a 1 kHz tone separated by silence.

    Mimics worm rasps / soil-arthropod tunnelling: energy concentrated in
    the bio band (500–2000 Hz) with high crest factor (peak >> mean).
    """
    samples = SR * DURATION
    out = np.zeros(samples, dtype=np.float32)
    t = np.arange(samples) / SR
    tone = np.sin(2 * np.pi * 1000 * t).astype(np.float32)

    burst_len = int(SR * 0.03)  # 30 ms per rasp
    for _ in range(20):
        start = int(rng.integers(0, samples - burst_len))
        out[start : start + burst_len] += tone[start : start + burst_len] * 0.1

    return out


# ── AudioChunk format validation ──────────────────────────────────────────────

def test_chunk_format():
    """AudioChunk for the soil probe must be float32 mono at 22050 Hz."""
    data = np.random.randn(SR * DURATION).astype(np.float32)
    chunk = _make_chunk(data)

    assert chunk.sample_rate == SR,            "Sample rate must be 22050 Hz"
    assert chunk.data.dtype == np.float32,     "Soil probe delivers float32 PCM"
    assert chunk.data.ndim == 1,               "Must be mono (1-D)"
    assert len(chunk.data) == SR * DURATION,   "3-second chunk"


# ── AudioProcessor bandpass validation ────────────────────────────────────────

def test_processor_bandpass_attenuates_below_50hz():
    """A 20 Hz tone (well below the 50 Hz high-pass cutoff) must be suppressed >30 dB."""
    proc = _make_processor()
    t = np.arange(SR * DURATION) / SR

    tone_20hz = np.sin(2 * np.pi * 20 * t).astype(np.float32)
    chunk = _make_chunk(tone_20hz)
    out = proc.process(chunk)

    in_rms  = np.sqrt(np.mean(tone_20hz ** 2))
    out_rms = np.sqrt(np.mean(out.data ** 2))
    attenuation_db = 20 * np.log10(out_rms / max(in_rms, 1e-10))

    assert attenuation_db < -30, (
        f"20 Hz tone should be suppressed >30 dB by the 50 Hz high-pass, "
        f"got {attenuation_db:.1f} dB"
    )


def test_processor_passes_bio_band():
    """A 1000 Hz tone (centre of the 500–2000 Hz bio band) must pass with <3 dB loss."""
    proc = _make_processor()
    t = np.arange(SR * DURATION) / SR

    tone_1khz = np.sin(2 * np.pi * 1000 * t).astype(np.float32)
    chunk = _make_chunk(tone_1khz)
    out = proc.process(chunk)

    in_rms  = np.sqrt(np.mean(tone_1khz ** 2))
    out_rms = np.sqrt(np.mean(out.data ** 2))
    attenuation_db = 20 * np.log10(out_rms / max(in_rms, 1e-10))

    assert attenuation_db > -3, (
        f"1 kHz tone should pass through with <3 dB loss, got {attenuation_db:.1f} dB"
    )


def test_processor_no_nan_or_inf():
    """Filtered output must never contain NaN or Inf (numerical stability check)."""
    proc = _make_processor()
    data = np.random.randn(SR * DURATION).astype(np.float32) * 0.05
    out = proc.process(_make_chunk(data))

    assert not np.any(np.isnan(out.data)), "NaN in filtered output"
    assert not np.any(np.isinf(out.data)), "Inf in filtered output"


# ── Silence gate ──────────────────────────────────────────────────────────────

def test_silence_returns_empty():
    """All-zeros chunk produces SAI ≈ 0.0, which falls below the default threshold.

    Uses the default min_confidence (0.1) because zeros produce a confidence of
    exactly 0.0 — too low to cross any meaningful detection threshold.
    """
    clf = SoilClassifier({})   # default min_confidence = 0.1
    proc = _make_processor()

    silent = np.zeros(SR * DURATION, dtype=np.float32)
    chunk = proc.process(_make_chunk(silent))
    dets = clf.classify(chunk)

    assert dets == [], "Silent chunk must produce no detections"


# ── SAI v2 metadata completeness ─────────────────────────────────────────────

def test_sai_v2_components_present():
    """Detection metadata must include all expected SAI v2 diagnostic keys."""
    clips = _find_soil_clips("Soil_Activity_—_High", n=1)
    if not clips:
        pytest.skip("No high-activity soil clips found in output/clips/")

    data, sr = sf.read(clips[0], dtype="float32", always_2d=False)
    assert sr == SR, f"Clip has sr={sr}, expected {SR}"

    proc = _make_processor()
    clf  = _make_classifier({"min_confidence": 0.0})

    chunk = proc.process(_make_chunk(data))
    dets  = clf.classify(chunk)

    assert len(dets) >= 1, "Expected at least one detection with min_confidence=0.0"
    meta = dets[0].metadata

    required = ("sai_v2", "ndsi", "transient_gate", "bio_band_crest", "activity_level")
    for key in required:
        assert key in meta, f"Missing SAI v2 metadata key: '{key}'"


# ── Real clip detection ───────────────────────────────────────────────────────

@pytest.mark.parametrize("clip_path", _find_soil_clips("Soil_Activity_—_High", n=3))
def test_high_activity_clip_detects(clip_path):
    """Real high-activity soil clips must produce at least one Detection.

    Pipeline:
        WAV → AudioChunk(22050 Hz) → AudioProcessor(bandpass) → SoilClassifier → Detection
    """
    data, sr = sf.read(clip_path, dtype="float32", always_2d=False)
    assert sr == SR, (
        f"Clip {os.path.basename(clip_path)} has sr={sr}, expected {SR}. "
        "Clips must be saved at the soil classifier's sample rate."
    )
    assert data.ndim == 1, "Clips must be mono"

    proc = _make_processor()
    clf  = _make_classifier({"min_confidence": 0.05})

    chunk = proc.process(_make_chunk(data))
    dets  = clf.classify(chunk)

    assert len(dets) >= 1, (
        f"Expected ≥1 detection for high-activity clip {os.path.basename(clip_path)}"
    )
    assert 0.0 <= dets[0].confidence <= 1.0, "Confidence out of range"
    assert dets[0].classifier == "soil",      "Wrong classifier label"


@pytest.mark.parametrize("clip_path", _find_soil_clips("Soil_Activity_—_Moderate", n=3))
def test_moderate_activity_clip_detects(clip_path):
    """Real moderate-activity soil clips must produce at least one Detection."""
    data, sr = sf.read(clip_path, dtype="float32", always_2d=False)
    assert sr == SR, (
        f"Clip {os.path.basename(clip_path)} has sr={sr}, expected {SR}."
    )
    assert data.ndim == 1, "Clips must be mono"

    proc = _make_processor()
    clf  = _make_classifier({"min_confidence": 0.05})

    chunk = proc.process(_make_chunk(data))
    dets  = clf.classify(chunk)

    assert len(dets) >= 1, (
        f"Expected ≥1 detection for moderate-activity clip {os.path.basename(clip_path)}"
    )
    assert 0.0 <= dets[0].confidence <= 1.0, "Confidence out of range"
    assert dets[0].classifier == "soil",      "Wrong classifier label"


# ── NDSI spectral discrimination ─────────────────────────────────────────────

def test_ndsi_positive_for_bio_signal():
    """Bursty 1 kHz signal must produce a positive NDSI (bio band dominates anthro band).

    Simulates earthworm rasps / soil-arthropod tunnelling: short bursts of energy
    at 1 kHz (inside the 500–2000 Hz bio band), well above the 50–300 Hz anthro band.
    """
    rng  = np.random.default_rng(42)
    proc = _make_processor()
    clf  = _make_classifier({"min_confidence": 0.0})

    sig   = _make_bursty_bio_signal(rng)
    chunk = proc.process(_make_chunk(sig))
    dets  = clf.classify(chunk)

    assert len(dets) >= 1, "Expected detection for bio signal with min_confidence=0.0"
    ndsi = dets[0].metadata["ndsi"]
    assert ndsi > 0, (
        f"NDSI should be positive when bio band (500–2000 Hz) dominates, got {ndsi:.4f}"
    )


def test_ndsi_negative_for_rumble():
    """Continuous 60 Hz rumble must drive NDSI negative (anthro band dominates bio band).

    Simulates vehicle/footstep vibration conducted through the soil: a steady low-
    frequency sine well inside the 50–300 Hz anthropogenic band and absent from the
    500–2000 Hz biological band.
    """
    proc = _make_processor()
    clf  = _make_classifier({"min_confidence": 0.0})

    t      = np.arange(SR * DURATION) / SR
    rumble = (np.sin(2 * np.pi * 60 * t) * 0.1).astype(np.float32)
    chunk  = proc.process(_make_chunk(rumble))
    dets   = clf.classify(chunk)

    assert len(dets) >= 1, "Expected detection for rumble signal with min_confidence=0.0"
    ndsi = dets[0].metadata["ndsi"]
    assert ndsi < 0, (
        f"NDSI should be negative for 60 Hz rumble (anthro band dominates), got {ndsi:.4f}"
    )


# ── Transient gate discrimination ─────────────────────────────────────────────

def test_transient_gate_high_for_bursty():
    """Bursty 1 kHz signal (worm-rasp pattern) must produce transient_gate > 0.3.

    High crest factor in the bio band — peak/mean well above the gate_high
    threshold of 4.0 — means the gate opens towards 1.0.
    """
    rng  = np.random.default_rng(7)
    proc = _make_processor()
    clf  = _make_classifier({"min_confidence": 0.0})

    sig   = _make_bursty_bio_signal(rng)
    chunk = proc.process(_make_chunk(sig))
    dets  = clf.classify(chunk)

    assert len(dets) >= 1, "Expected detection for bursty signal with min_confidence=0.0"
    gate = dets[0].metadata["transient_gate"]
    assert gate > 0.3, (
        f"Bursty signal should have transient_gate > 0.3 (high crest factor), got {gate:.3f}"
    )


def test_transient_gate_low_for_continuous():
    """Continuous 1 kHz sine must produce transient_gate < 0.3 (low crest factor).

    A steady-state sine has near-constant short-time RMS (peak ≈ mean → crest ≈ 1),
    which falls below the gate_low threshold of 1.5, keeping the gate fully closed.
    """
    proc = _make_processor()
    clf  = _make_classifier({"min_confidence": 0.0})

    t          = np.arange(SR * DURATION) / SR
    continuous = (np.sin(2 * np.pi * 1000 * t) * 0.05).astype(np.float32)
    chunk      = proc.process(_make_chunk(continuous))
    dets       = clf.classify(chunk)

    assert len(dets) >= 1, "Expected detection for continuous signal with min_confidence=0.0"
    gate = dets[0].metadata["transient_gate"]
    assert gate < 0.3, (
        f"Continuous sine should have transient_gate < 0.3 (crest ≈ 1 → gate closed), "
        f"got {gate:.3f}"
    )
