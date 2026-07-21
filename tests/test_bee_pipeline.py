"""
End-to-end test of the bee detection pipeline using BuzzDetect / YAMNet.

Validates the full signal path:
  Microphone (16 kHz float32 PCM)
    → AudioChunk
    → AudioProcessor  (bandpass 80–1500 Hz, no resampling)
    → BeeClassifier   (YAMNet embeddings → BuzzDetect transfer model)
    → Detection

Uses real captured clips from output/clips/Honey_Bee/ when the BuzzDetect
model is available.  Tests that do not require the model are always run.

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
from ecoacoustics.classifiers.bee import BeeClassifier

# ── Model availability ────────────────────────────────────────────────────────

from pathlib import Path
BUZZDETECT_AVAILABLE = Path(os.path.join(ROOT, "external", "buzzdetect")).exists()

# ── Constants ─────────────────────────────────────────────────────────────────

BEE_RATE      = 16_000   # YAMNet native sample rate
BEE_CLIP_DIR  = os.path.join(ROOT, "output", "clips", "Honey_Bee")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _find_bee_clips(n: int = 3) -> list[str]:
    """Return up to n real Honey Bee clips from the output directory."""
    pattern = os.path.join(BEE_CLIP_DIR, "*.wav")
    clips = sorted(glob.glob(pattern))
    return clips[:n]


def _make_chunk(data: np.ndarray, sample_rate: int) -> AudioChunk:
    return AudioChunk(data=data.astype(np.float32), sample_rate=sample_rate, timestamp=time.time())


def _make_processor() -> AudioProcessor:
    return AudioProcessor(
        target_sample_rate=BEE_RATE,
        freq_min_hz=80,
        freq_max_hz=1500,
    )


def _make_classifier(overrides: dict | None = None) -> BeeClassifier:
    cfg = {
        "logit_threshold": -1.45,
        "include_trill": False,
    }
    if overrides:
        cfg.update(overrides)
    clf = BeeClassifier(cfg)
    clf.load()
    return clf


# ── AudioChunk format validation ──────────────────────────────────────────────

def test_chunk_format():
    """AudioChunk for bee pipeline must be float32 mono at 16 kHz."""
    data = np.random.randn(BEE_RATE * 3).astype(np.float32)
    chunk = _make_chunk(data, BEE_RATE)

    assert chunk.sample_rate == BEE_RATE,           "Sample rate must be 16 kHz"
    assert chunk.data.dtype == np.float32,           "BeeClassifier expects float32 PCM"
    assert chunk.data.ndim == 1,                     "Must be mono (1-D)"
    assert len(chunk.data) == BEE_RATE * 3,          "3-second chunk"


# ── AudioProcessor bandpass validation ────────────────────────────────────────

def test_processor_bandpass_attenuates_outside_range():
    """Signals below 80 Hz must be heavily attenuated by the bandpass filter."""
    proc = _make_processor()
    sr = BEE_RATE
    t = np.arange(sr * 3) / sr

    # 30 Hz tone — well below the 80 Hz cutoff; 5th-order Butterworth gives ~42 dB there
    tone_30hz = np.sin(2 * np.pi * 30 * t).astype(np.float32)
    chunk = _make_chunk(tone_30hz, sr)
    out = proc.process(chunk)

    in_rms  = np.sqrt(np.mean(tone_30hz ** 2))
    out_rms = np.sqrt(np.mean(out.data ** 2))
    attenuation_db = 20 * np.log10(out_rms / max(in_rms, 1e-10))
    assert attenuation_db < -30, (
        f"30 Hz tone should be suppressed >30 dB by the 80 Hz high-pass, "
        f"got {attenuation_db:.1f} dB"
    )


def test_processor_passes_bee_buzz_band():
    """A 500 Hz tone (centre of bee buzz band 80–1500 Hz) must pass through."""
    proc = _make_processor()
    sr = BEE_RATE
    t = np.arange(sr * 3) / sr

    tone_500hz = np.sin(2 * np.pi * 500 * t).astype(np.float32)
    chunk = _make_chunk(tone_500hz, sr)
    out = proc.process(chunk)

    in_rms  = np.sqrt(np.mean(tone_500hz ** 2))
    out_rms = np.sqrt(np.mean(out.data ** 2))
    attenuation_db = 20 * np.log10(out_rms / max(in_rms, 1e-10))
    # Passband: expect < 3 dB attenuation
    assert attenuation_db > -3, (
        f"500 Hz tone should pass through the bandpass with <3 dB loss, "
        f"got {attenuation_db:.1f} dB"
    )


def test_processor_no_nan_or_inf():
    """Filtered output must never contain NaN or Inf (numerical stability check)."""
    proc = _make_processor()
    data = np.random.randn(BEE_RATE * 3).astype(np.float32) * 0.05
    out = proc.process(_make_chunk(data, BEE_RATE))

    assert not np.any(np.isnan(out.data)), "NaN in filtered output"
    assert not np.any(np.isinf(out.data)), "Inf in filtered output"


# ── No-model guard ────────────────────────────────────────────────────────────

def test_no_model_returns_empty():
    """BeeClassifier without calling load() must return [] from classify()."""
    clf = BeeClassifier({})
    # Deliberately skip clf.load() — _yamnet_infer and _transfer_infer stay None

    data = np.random.randn(BEE_RATE * 3).astype(np.float32) * 0.01
    chunk = _make_chunk(data, BEE_RATE)
    dets = clf.classify(chunk)

    assert dets == [], (
        f"Expected [] when models are not loaded, got {dets}"
    )


# ── Clip file validation ───────────────────────────────────────────────────────

def test_clip_sample_rate():
    """Honey Bee clips on disk must be at 16 kHz (YAMNet native rate)."""
    clips = _find_bee_clips(n=1)
    if not clips:
        pytest.skip("No Honey_Bee clips found in output/clips/Honey_Bee/")

    data, sr = sf.read(clips[0], dtype="float32", always_2d=False)
    assert sr == BEE_RATE, (
        f"Clip {os.path.basename(clips[0])} has sr={sr}, expected {BEE_RATE}. "
        "Clips must be saved at the YAMNet sample rate."
    )
    assert data.ndim == 1, "Clips must be mono"


# ── Model-dependent tests ─────────────────────────────────────────────────────

@pytest.mark.skipif(not BUZZDETECT_AVAILABLE, reason="BuzzDetect model not available")
def test_real_clip_produces_detection():
    """
    A real Honey Bee clip must survive the full pipeline and produce at least
    one Detection with classifier=='bee' and a plausible confidence score.

    Pipeline:
        WAV → AudioChunk(16kHz) → BeeClassifier → Detection
    """
    clips = _find_bee_clips(n=1)
    if not clips:
        pytest.skip("No Honey_Bee clips found in output/clips/Honey_Bee/")

    clip_path = clips[0]
    data, sr = sf.read(clip_path, dtype="float32", always_2d=False)

    assert sr == BEE_RATE, (
        f"Clip {os.path.basename(clip_path)} has sr={sr}, expected {BEE_RATE}."
    )

    clf   = _make_classifier()
    chunk = _make_chunk(data, BEE_RATE)
    dets  = clf.classify(chunk)

    assert len(dets) >= 1, (
        f"Expected >=1 detection for {os.path.basename(clip_path)}, got 0. "
        "Check that logit_threshold is not too high for this clip."
    )

    det = dets[0]
    assert det.classifier == "bee",         f"Wrong classifier label: {det.classifier}"
    assert 0 < det.confidence <= 1,         f"Confidence out of range: {det.confidence}"
    assert det.label,                        "Detection label must not be empty"
    assert "buzz_logit" in det.metadata,     "buzz_logit missing from metadata"
    assert "category"   in det.metadata,     "category missing from metadata"

    clf.cleanup()


@pytest.mark.skipif(not BUZZDETECT_AVAILABLE, reason="BuzzDetect model not available")
def test_silence_returns_empty():
    """A silent (all-zeros) chunk must return [] — no detections."""
    clf = _make_classifier()

    silent = np.zeros(BEE_RATE * 3, dtype=np.float32)
    chunk  = _make_chunk(silent, BEE_RATE)
    dets   = clf.classify(chunk)

    assert dets == [], f"Silent chunk must produce no detections, got {dets}"

    clf.cleanup()


@pytest.mark.skipif(not BUZZDETECT_AVAILABLE, reason="BuzzDetect model not available")
def test_white_noise_no_detection():
    """
    Low-level Gaussian noise must not produce bee detections.
    The logit threshold should filter unstructured wideband noise.
    """
    clf = _make_classifier()

    rng   = np.random.default_rng(42)
    noise = rng.standard_normal(BEE_RATE * 3).astype(np.float32) * 0.002
    chunk = _make_chunk(noise, BEE_RATE)
    dets  = clf.classify(chunk)

    assert dets == [], (
        f"White noise produced {len(dets)} detections: {[d.label for d in dets]}. "
        "False positive — check logit_threshold."
    )

    clf.cleanup()


# ── BaseClassifier property checks ────────────────────────────────────────────

def test_report_cooldown_default():
    """BeeClassifier must expose report_cooldown_secs as a float >= 0."""
    clf = BeeClassifier({})

    cooldown = clf.report_cooldown_secs
    assert isinstance(cooldown, float), (
        f"report_cooldown_secs must be a float, got {type(cooldown).__name__}"
    )
    assert cooldown >= 0.0, (
        f"report_cooldown_secs must be >= 0, got {cooldown}"
    )
