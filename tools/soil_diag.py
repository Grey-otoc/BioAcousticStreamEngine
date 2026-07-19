#!/usr/bin/env python3
"""
Soil classifier diagnostic — records 9 seconds from the configured device
and shows exactly what the classifier is computing on each 3-second chunk.

Usage:
    cd ~/Documents/Ecoacoustics
    .venv/bin/python3 tools/soil_diag.py [device_name_or_index]

If no device is given, reads the first mic in settings.yaml that has 'soil'
in its classifiers list.
"""

import sys, os, time, warnings
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import sounddevice as sd
import yaml

SAMPLE_RATE = 22050
CHUNK_SECS  = 3
N_CHUNKS    = 3

# ── Load config ──────────────────────────────────────────────────────────────
with open("config/settings.yaml") as f:
    cfg = yaml.safe_load(f)

soil_cfg = cfg.get("soil", {})

# Find device from args or config
device = None
if len(sys.argv) > 1:
    arg = sys.argv[1]
    device = int(arg) if arg.isdigit() else arg
else:
    for mic in cfg.get("mics") or []:
        if "soil" in (mic.get("classifiers") or []) and mic.get("device"):
            device = mic["device"]
            print(f"Using device from settings.yaml: {device}")
            break

if device is None:
    print("No soil device found in settings.yaml and no device argument given.")
    print("Available devices:")
    print(sd.query_devices())
    sys.exit(1)

# ── Load classifier ──────────────────────────────────────────────────────────
sys.path.insert(0, "src")
from ecoacoustics.classifiers.soil import SoilClassifier
from ecoacoustics.audio.capture import AudioChunk
from ecoacoustics.audio.processor import AudioProcessor

clf = SoilClassifier(soil_cfg)
proc = AudioProcessor(
    target_sample_rate=SAMPLE_RATE,
    freq_min_hz=50,
    freq_max_hz=2000,
)

print(f"\nSoil classifier config:")
print(f"  min_confidence  : {clf._min_confidence}")
print(f"  bio_rms_scale   : {clf._bio_rms_scale}")
print(f"  ndsi enabled    : {clf._v2_enabled}")
print(f"  bio_hz          : {clf._bio_hz}")
print(f"  anthro_hz       : {clf._anthro_hz}")
print(f"  gate_low/high   : {clf._gate_low} / {clf._gate_high}")
print(f"\nRecording {N_CHUNKS * CHUNK_SECS}s from device: {device}\n")

# ── Record & analyse ─────────────────────────────────────────────────────────
try:
    audio, _ = sd.rec(
        int(SAMPLE_RATE * CHUNK_SECS * N_CHUNKS),
        samplerate=SAMPLE_RATE,
        channels=1,
        dtype="float32",
        device=device,
        blocking=True,
    )
except Exception as e:
    print(f"ERROR recording from device: {e}")
    print("\nAvailable devices:")
    print(sd.query_devices())
    sys.exit(1)

audio = audio.ravel()
print(f"Recorded {len(audio)/SAMPLE_RATE:.1f}s  overall RMS: {np.sqrt(np.mean(audio**2)):.6f}\n")

# Force min_confidence to 0 so we always get metadata back
clf._min_confidence = 0.0

for i in range(N_CHUNKS):
    chunk_data = audio[i * SAMPLE_RATE * CHUNK_SECS : (i+1) * SAMPLE_RATE * CHUNK_SECS]
    chunk = AudioChunk(data=chunk_data, sample_rate=SAMPLE_RATE, timestamp=time.time())
    processed = proc.process(chunk)

    dets = clf.classify(processed)
    if not dets:
        print(f"Chunk {i+1}: no output from classifier (audio may be empty)")
        continue

    m = dets[0].metadata
    print(f"Chunk {i+1}:")
    print(f"  overall RMS      : {np.sqrt(np.mean(processed.data**2)):.6f}")
    print(f"  sai_v2           : {m.get('sai_v2', 'N/A')}  ← primary score (need > {soil_cfg.get('min_confidence', 0.1)} to detect)")
    print(f"  ndsi             : {m.get('ndsi', 'N/A')}  (-1=all noise, +1=all bio)")
    print(f"  bio_rms          : {m.get('bio_rms', 'N/A')}")
    print(f"  bio_band_power   : {m.get('bio_band_power', 'N/A')}")
    print(f"  anthro_band_power: {m.get('anthro_band_power', 'N/A')}")
    print(f"  bio_band_crest   : {m.get('bio_band_crest', 'N/A')}  (>4 = bursty/biological, <1.5 = continuous noise)")
    print(f"  transient_gate   : {m.get('transient_gate', 'N/A')}  (0=no gate, 1=fully open)")
    print(f"  activity_index   : {m.get('activity_index', 'N/A')}  activity: {m.get('activity_level', 'N/A')}")
    print(f"  sai_v1 (legacy)  : {m.get('sai_v1', 'N/A')}")

    # Diagnose which term is killing the score
    sai_v2 = m.get('sai_v2')
    if sai_v2 is not None and sai_v2 < soil_cfg.get('min_confidence', 0.1):
        ndsi = m.get('ndsi', 0)
        bio_rms = m.get('bio_rms', 0)
        tgate = m.get('transient_gate', 0)
        causes = []
        if ndsi is not None and ndsi < -0.3:
            causes.append(f"NDSI={ndsi:.3f} — too much low-freq noise (traffic/footsteps/HVAC)")
        if bio_rms is not None and bio_rms < clf._bio_rms_scale * 0.1:
            causes.append(f"bio_rms={bio_rms:.6f} — very quiet in 500-2000Hz band (probe not coupled?)")
        if tgate is not None and tgate < 0.1:
            causes.append(f"transient_gate={tgate:.3f} — signal is continuous not bursty (electronic noise?)")
        if causes:
            print(f"  >> LOW SCORE because: {'; '.join(causes)}")
        else:
            print(f"  >> Score {sai_v2:.4f} is below threshold {soil_cfg.get('min_confidence', 0.1)} — try lowering min_confidence")
    print()

print("Diagnosis complete.")
print("If all scores are near 0, check:")
print("  1. Is a contact microphone/geophone connected to the soil probe rod?")
print("  2. Is the probe rod inserted ≥15 cm into soil?")
print("  3. Is the device index/name correct in settings.yaml?")
print("  4. Is bio_rms_scale tuned to your probe sensitivity?")
