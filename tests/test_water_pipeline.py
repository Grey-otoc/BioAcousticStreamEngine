"""
End-to-end test of the water acoustic index pipeline.

Validates the full signal path:
  AudioChunk (44100 Hz float32 PCM)
    → AudioProcessor  (bandpass 10–8000 Hz)
    → WaterClassifier (WAI = ndwi_01 × bio_rms_norm × aci_01)
    → Detection

No real water clips exist yet; all tests use synthetic signals designed to
exercise spectral discrimination, mains-notch behaviour, and ACI scoring.

Deployment context: hydrophone submerged in the Great Lake, Blenheim Palace.

Author: David Green, Blenheim Palace
"""

import os
import time

import numpy as np
import pytest

# Resolve project root so tests run from any cwd
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

import sys
sys.path.insert(0, os.path.join(ROOT, "src"))

from ecoacoustics.audio.capture import AudioChunk
from ecoacoustics.audio.processor import AudioProcessor
from ecoacoustics.classifiers.water import WaterClassifier

# ── Constants ─────────────────────────────────────────────────────────────────

SR       = 44100   # WaterClassifier.sample_rate
FREQ_MIN = 10      # WaterClassifier.freq_min_hz
FREQ_MAX = 8000    # WaterClassifier.freq_max_hz
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


def _make_classifier(overrides: dict | None = None) -> WaterClassifier:
    cfg: dict = {"min_confidence": 0.0}
    if overrides:
        cfg.update(overrides)
    return WaterClassifier(cfg)


def _make_bursty_bio_signal(rng: np.random.Generator, amplitude: float = 0.1) -> np.ndarray:
    """Twenty 30 ms bursts of a 1 kHz tone separated by silence.

    Mimics fish spawning calls / freshwater invertebrate clicks: energy
    concentrated in the bio band (300–5000 Hz) with high ACI and high
    crest factor.
    """
    samples = SR * DURATION
    out = np.zeros(samples, dtype=np.float32)
    t = np.arange(samples) / SR
    tone = np.sin(2 * np.pi * 1000 * t).astype(np.float32)

    burst_len = int(SR * 0.03)  # 30 ms per call
    for _ in range(20):
        start = int(rng.integers(0, samples - burst_len))
        out[start : start + burst_len] += tone[start : start + burst_len] * amplitude

    return out


# ── AudioChunk format validation ──────────────────────────────────────────────

def test_chunk_format():
    """AudioChunk for the hydrophone must be float32 mono at 44100 Hz."""
    data = np.random.randn(SR * DURATION).astype(np.float32)
    chunk = _make_chunk(data)

    assert chunk.sample_rate == SR,          "Sample rate must be 44100 Hz"
    assert chunk.data.dtype == np.float32,   "Hydrophone delivers float32 PCM"
    assert chunk.data.ndim == 1,             "Must be mono (1-D)"
    assert len(chunk.data) == SR * DURATION, "3-second chunk"


# ── AudioProcessor bandpass validation ────────────────────────────────────────

def test_processor_bandpass_attenuates_below_10hz():
    """A 5 Hz tone (below the 10 Hz high-pass cutoff) must be significantly attenuated."""
    proc = _make_processor()
    t = np.arange(SR * DURATION) / SR

    tone_5hz = np.sin(2 * np.pi * 5 * t).astype(np.float32)
    chunk = _make_chunk(tone_5hz)
    out = proc.process(chunk)

    in_rms  = np.sqrt(np.mean(tone_5hz ** 2))
    out_rms = np.sqrt(np.mean(out.data ** 2))
    attenuation_db = 20 * np.log10(out_rms / max(in_rms, 1e-10))

    assert attenuation_db < -20, (
        f"5 Hz tone should be suppressed >20 dB by the 10 Hz high-pass, "
        f"got {attenuation_db:.1f} dB"
    )


def test_processor_passes_fish_call_band():
    """A 1000 Hz tone (fish call range) must pass through the bandpass with <3 dB loss."""
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


# ── WAI metadata completeness ─────────────────────────────────────────────────

def test_wai_components_present():
    """Detection metadata must include all expected WAI diagnostic keys."""
    rng  = np.random.default_rng(13)
    proc = _make_processor()
    clf  = _make_classifier({"min_confidence": 0.0})

    sig   = _make_bursty_bio_signal(rng)
    chunk = proc.process(_make_chunk(sig))
    dets  = clf.classify(chunk)

    assert len(dets) >= 1, "Expected detection for bio signal with min_confidence=0.0"
    meta = dets[0].metadata

    required = ("wai", "ndwi", "bio_rms", "aci", "activity_level")
    for key in required:
        assert key in meta, f"Missing WAI metadata key: '{key}'"


# ── NDWI spectral discrimination ─────────────────────────────────────────────

def test_ndwi_positive_for_bio_signal():
    """Bursty 1 kHz bursts must produce a positive NDWI (bio band dominates anthro band).

    Fish calls and invertebrate clicks fall in the 300–5000 Hz biological band,
    far above the 10–200 Hz anthropogenic rumble band.
    """
    rng  = np.random.default_rng(42)
    proc = _make_processor()
    clf  = _make_classifier({"min_confidence": 0.0})

    sig   = _make_bursty_bio_signal(rng)
    chunk = proc.process(_make_chunk(sig))
    dets  = clf.classify(chunk)

    assert len(dets) >= 1, "Expected detection for bio signal with min_confidence=0.0"
    ndwi = dets[0].metadata["ndwi"]
    assert ndwi > 0, (
        f"NDWI should be positive when bio band (300–5000 Hz) dominates, got {ndwi:.4f}"
    )


def test_ndwi_negative_for_anthro_noise():
    """Continuous low-frequency rumble must drive NDWI negative (anthro band dominates).

    Simulates a distant boat motor or flow rumble: a steady 75 Hz sine inside
    the 10–200 Hz anthropogenic band, absent from the 300–5000 Hz biological band.
    (75 Hz is not a notch frequency, so it is not removed by the mains cascade.)
    """
    proc = _make_processor()
    clf  = _make_classifier({"min_confidence": 0.0})

    t      = np.arange(SR * DURATION) / SR
    rumble = (np.sin(2 * np.pi * 75 * t) * 0.1).astype(np.float32)
    chunk  = proc.process(_make_chunk(rumble))
    dets   = clf.classify(chunk)

    assert len(dets) >= 1, "Expected detection for rumble signal with min_confidence=0.0"
    ndwi = dets[0].metadata["ndwi"]
    assert ndwi < 0, (
        f"NDWI should be negative when anthro band (10–200 Hz) dominates, got {ndwi:.4f}"
    )


def test_mains_notch_reduces_50hz_contamination():
    """Mains notch at 50 Hz must prevent cable-conducted hum from driving NDWI negative.

    Without the notch, 50 Hz would inflate the anthropogenic band (10–200 Hz) and
    push NDWI strongly negative even when biological signal (1 kHz) is also present.
    With the notch applied, 50 Hz is stripped out and the bio band should dominate.
    """
    proc = _make_processor()
    clf  = _make_classifier({"min_confidence": 0.0})

    t = np.arange(SR * DURATION) / SR
    # Equal-amplitude 50 Hz (mains hum) + 1 kHz (bio signal)
    mixed = (np.sin(2 * np.pi * 50 * t) + np.sin(2 * np.pi * 1000 * t)).astype(np.float32) * 0.05
    chunk = proc.process(_make_chunk(mixed))
    dets  = clf.classify(chunk)

    assert len(dets) >= 1, "Expected detection for mixed signal with min_confidence=0.0"
    ndwi = dets[0].metadata["ndwi"]
    # After the 50 Hz notch, the bio band (1 kHz) should dominate → NDWI positive
    assert ndwi > 0, (
        f"NDWI should be positive after 50 Hz notch removes mains contamination, "
        f"got {ndwi:.4f}. Check that the notch cascade is active."
    )


# ── Threshold detection ───────────────────────────────────────────────────────

def test_bio_signal_above_threshold():
    """Strong bursty 1 kHz signal must exceed the detection threshold.

    Amplitude 0.1 produces bio_rms well above bio_rms_scale (0.005), pushing
    bio_rms_norm to 1.0. Combined with high NDWI and positive ACI, WAI > 0.05.
    """
    rng  = np.random.default_rng(99)
    proc = _make_processor()
    clf  = _make_classifier({"min_confidence": 0.05})

    sig   = _make_bursty_bio_signal(rng, amplitude=0.1)
    chunk = proc.process(_make_chunk(sig))
    dets  = clf.classify(chunk)

    assert len(dets) >= 1, (
        "Strong bursty 1 kHz signal (amplitude=0.1) must exceed min_confidence=0.05. "
        f"Check bio_rms_scale and aci_scale config defaults."
    )
    assert 0.0 < dets[0].confidence <= 1.0, "Confidence out of range"
    assert dets[0].classifier == "water",    "Wrong classifier label"


def test_silence_below_threshold():
    """All-zeros chunk produces WAI = 0.0, which falls below the default threshold.

    Uses the default min_confidence (0.1) because zeros produce a WAI of exactly
    0.0 — bio_rms_norm = 0, so the multiplicative score collapses regardless of
    the NDWI or ACI terms.
    """
    clf = WaterClassifier({})   # default min_confidence = 0.1
    proc = _make_processor()

    silent = np.zeros(SR * DURATION, dtype=np.float32)
    chunk  = proc.process(_make_chunk(silent))
    dets   = clf.classify(chunk)

    assert dets == [], "Silent chunk must produce no detections"


# ── Configuration ─────────────────────────────────────────────────────────────

def test_report_cooldown_set():
    """WaterClassifier.report_cooldown_secs must return the configured value (default 30 s)."""
    clf = _make_classifier()   # min_confidence=0.0; report_cooldown uses default 30
    assert clf.report_cooldown_secs == 30.0, (
        f"Expected report_cooldown_secs == 30.0, got {clf.report_cooldown_secs}"
    )
