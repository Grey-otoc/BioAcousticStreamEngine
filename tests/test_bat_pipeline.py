"""
End-to-end test of the bat detection pipeline as it runs from an AudioMoth.

Validates the full signal path:
  AudioMoth (384 kHz float32 PCM)
    → AudioChunk
    → AudioProcessor  (bandpass 10–120 kHz, no resampling)
    → BatClassifier   (→ /dev/shm WAV → BatDetect2 at 256 kHz)
    → Detection

Uses real captured clips from output/clips/*Bat*/ so BatDetect2 is tested
against audio it has already confirmed as genuine bat calls.

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
from ecoacoustics.classifiers.bat import BatClassifier

# ── Fixtures ─────────────────────────────────────────────────────────────────

AUDIOMOTH_RATE = 384_000   # AudioMoth USB Microphone capture rate
BAT_CLIP_DIRS  = ["Brown_Long-eared_Bat", "Leisler's_Bat", "Natterer's_Bat"]


def _find_bat_clips(n: int = 3) -> list[str]:
    """Return up to n real bat clips from the output directory."""
    clips = []
    for d in BAT_CLIP_DIRS:
        pattern = os.path.join(ROOT, "output", "clips", d, "*.wav")
        clips.extend(glob.glob(pattern))
        if len(clips) >= n:
            break
    return clips[:n]


def _make_chunk(data: np.ndarray, sample_rate: int) -> AudioChunk:
    return AudioChunk(data=data.astype(np.float32), sample_rate=sample_rate, timestamp=time.time())


def _make_processor() -> AudioProcessor:
    return AudioProcessor(
        target_sample_rate=AUDIOMOTH_RATE,
        freq_min_hz=10_000,
        freq_max_hz=120_000,
    )


def _make_classifier(overrides: dict | None = None) -> BatClassifier:
    cfg = {
        "capture_rate": AUDIOMOTH_RATE,
        "min_det_confidence": 0.4,
        "min_class_confidence": 0.4,
        "silence_threshold": 0.0001,  # very low so test clips are never skipped
        "report_cooldown_secs": 0,
    }
    if overrides:
        cfg.update(overrides)
    clf = BatClassifier(cfg)
    clf.load()
    return clf


# ── AudioChunk format validation ──────────────────────────────────────────────

def test_audiomoth_chunk_format():
    """AudioChunk from AudioMoth must be float32 mono at 384 kHz."""
    data = np.random.randn(AUDIOMOTH_RATE * 3).astype(np.float32)
    chunk = _make_chunk(data, AUDIOMOTH_RATE)

    assert chunk.sample_rate == AUDIOMOTH_RATE, "Sample rate must be 384 kHz"
    assert chunk.data.dtype == np.float32,      "AudioMoth delivers float32 PCM"
    assert chunk.data.ndim == 1,                "Must be mono (1-D)"
    assert len(chunk.data) == AUDIOMOTH_RATE * 3, "3-second chunk"


# ── AudioProcessor bandpass validation ────────────────────────────────────────

def test_processor_preserves_sample_rate():
    """Processor must not resample — bat capture rate == classifier sample rate."""
    proc = _make_processor()
    data = np.random.randn(AUDIOMOTH_RATE * 3).astype(np.float32) * 0.01
    chunk = _make_chunk(data, AUDIOMOTH_RATE)
    out = proc.process(chunk)

    assert out.sample_rate == AUDIOMOTH_RATE, "No resampling expected for bat"
    assert len(out.data) == len(chunk.data),  "Length must be unchanged"
    assert out.data.dtype == np.float32


def test_processor_bandpass_attenuates_low_freq():
    """Signals below 10 kHz must be heavily attenuated by the bandpass filter."""
    proc = _make_processor()
    sr = AUDIOMOTH_RATE
    t = np.arange(sr * 3) / sr

    # Pure 1 kHz tone — well below bat band (10–120 kHz)
    tone_1khz = (np.sin(2 * np.pi * 1_000 * t)).astype(np.float32)
    chunk = _make_chunk(tone_1khz, sr)
    out = proc.process(chunk)

    # After 10 kHz high-pass, 1 kHz energy should be suppressed by >40 dB
    in_rms  = np.sqrt(np.mean(tone_1khz ** 2))
    out_rms = np.sqrt(np.mean(out.data ** 2))
    attenuation_db = 20 * np.log10(out_rms / max(in_rms, 1e-10))
    assert attenuation_db < -40, f"1 kHz tone should be suppressed >40 dB, got {attenuation_db:.1f} dB"


def test_processor_passes_bat_band():
    """A 40 kHz tone (Common Pipistrelle range) must pass through the bandpass."""
    proc = _make_processor()
    sr = AUDIOMOTH_RATE
    t = np.arange(sr * 3) / sr

    tone_40khz = (np.sin(2 * np.pi * 40_000 * t)).astype(np.float32)
    chunk = _make_chunk(tone_40khz, sr)
    out = proc.process(chunk)

    in_rms  = np.sqrt(np.mean(tone_40khz ** 2))
    out_rms = np.sqrt(np.mean(out.data ** 2))
    attenuation_db = 20 * np.log10(out_rms / max(in_rms, 1e-10))
    # Passband: expect < 3 dB attenuation
    assert attenuation_db > -3, f"40 kHz tone should pass through (<3 dB loss), got {attenuation_db:.1f} dB"


def test_processor_no_nan_or_inf():
    """Filtered output must never contain NaN or Inf (numerical stability check)."""
    proc = _make_processor()
    data = np.random.randn(AUDIOMOTH_RATE * 3).astype(np.float32) * 0.05
    out = proc.process(_make_chunk(data, AUDIOMOTH_RATE))

    assert not np.any(np.isnan(out.data)), "NaN in filtered output"
    assert not np.any(np.isinf(out.data)), "Inf in filtered output"


# ── Silence gate ──────────────────────────────────────────────────────────────

def test_silence_gate_skips_inference():
    """Near-silent chunks must return [] without calling BatDetect2."""
    clf = _make_classifier({"silence_threshold": 0.01})
    proc = _make_processor()

    silent = np.zeros(AUDIOMOTH_RATE * 3, dtype=np.float32)
    chunk = proc.process(_make_chunk(silent, AUDIOMOTH_RATE))
    dets = clf.classify(chunk)

    assert dets == [], "Silent chunk must produce no detections"

    clf.cleanup()


# ── End-to-end detection on real AudioMoth clips ──────────────────────────────

@pytest.mark.parametrize("clip_path", _find_bat_clips(n=3))
def test_real_clip_produces_detection(clip_path):
    """
    Real bat clips captured by AudioMoth at 384 kHz must survive the full
    pipeline and produce at least one Detection with a plausible species label.

    Pipeline:
        WAV → AudioChunk(384kHz) → AudioProcessor(bandpass) → BatClassifier → Detection
    """
    data, sr = sf.read(clip_path, dtype="float32", always_2d=False)

    assert sr == AUDIOMOTH_RATE, (
        f"Clip {os.path.basename(clip_path)} has sr={sr}, expected {AUDIOMOTH_RATE}. "
        "Clips must be saved at AudioMoth capture rate."
    )
    assert data.ndim == 1, "Clips must be mono"

    proc = _make_processor()
    clf  = _make_classifier()

    chunk     = _make_chunk(data, AUDIOMOTH_RATE)
    processed = proc.process(chunk)
    dets      = clf.classify(processed)

    species_name = os.path.basename(os.path.dirname(clip_path)).replace("_", " ")
    assert len(dets) >= 1, (
        f"Expected ≥1 detection for {species_name} clip {os.path.basename(clip_path)}, got 0. "
        "Check that BatDetect2 thresholds are not too high for this clip."
    )

    det = dets[0]
    assert 0.0 < det.confidence <= 1.0,  f"Confidence out of range: {det.confidence}"
    assert det.classifier == "bat",       f"Wrong classifier label: {det.classifier}"
    assert det.label,                     "Detection label must not be empty"
    assert "det_prob"    in det.metadata, "det_prob missing from metadata"
    assert "class_prob"  in det.metadata, "class_prob missing from metadata"
    assert "low_freq_hz" in det.metadata, "low_freq_hz missing from metadata"

    # Bat calls must be in the ultrasonic range
    low_hz = det.metadata["low_freq_hz"]
    assert low_hz > 10_000, f"Detected frequency {low_hz} Hz is below 10 kHz — likely a false positive"

    clf.cleanup()


# ── WAV temp file validation ───────────────────────────────────────────────────

def test_tmp_wav_written_at_capture_rate():
    """
    BatClassifier must write the temp WAV at capture_rate (384 kHz), not at
    BatDetect2's internal 256 kHz rate. If the rate is wrong, BatDetect2 will
    analyse the audio at the wrong time-scale and miss calls.
    """
    clf  = _make_classifier()
    proc = _make_processor()

    # Use a real clip if available, otherwise synthetic noise with energy
    clips = _find_bat_clips(n=1)
    if clips:
        data, _ = sf.read(clips[0], dtype="float32", always_2d=False)
    else:
        # Synthetic: broadband noise with energy in 40 kHz range
        rng = np.random.default_rng(0)
        data = rng.standard_normal(AUDIOMOTH_RATE * 3).astype(np.float32) * 0.05

    chunk     = _make_chunk(data, AUDIOMOTH_RATE)
    processed = proc.process(chunk)

    # Classify so the temp file gets written
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        clf.classify(processed)

    # Inspect the written WAV
    assert clf._tmp_path is not None, "Temp file path not set after classify()"
    assert os.path.exists(clf._tmp_path), f"Temp WAV not found at {clf._tmp_path}"

    info = sf.info(clf._tmp_path)
    assert info.samplerate == AUDIOMOTH_RATE, (
        f"Temp WAV written at {info.samplerate} Hz, expected {AUDIOMOTH_RATE}. "
        "BatDetect2 will time-stretch the audio if the rate is wrong."
    )
    assert info.channels == 1, "Temp WAV must be mono"

    clf.cleanup()
    assert not os.path.exists(clf._tmp_path), "cleanup() must delete the temp WAV"


# ── Noise produces no detection (false positive check) ────────────────────────

def test_white_noise_no_detection():
    """
    Gaussian noise at typical ambient level must not produce bat detections.
    At thresholds 0.5/0.5 BatDetect2 should not fire on unstructured noise.
    """
    clf  = _make_classifier({"min_det_confidence": 0.5, "min_class_confidence": 0.5})
    proc = _make_processor()

    rng = np.random.default_rng(42)
    noise = rng.standard_normal(AUDIOMOTH_RATE * 3).astype(np.float32) * 0.005
    processed = proc.process(_make_chunk(noise, AUDIOMOTH_RATE))
    dets = clf.classify(processed)

    assert dets == [], (
        f"White noise produced {len(dets)} detections: {[d.label for d in dets]}. "
        "False positive — check silence_threshold and confidence thresholds."
    )
    clf.cleanup()
