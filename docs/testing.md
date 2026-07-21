# BASE Test Suite

85 tests across 7 files. All tests run without a microphone — real model inference uses saved clips from `output/clips/`.

---

## Running the tests

```bash
# All tests
bash run_tests.sh

# Single classifier
bash run_tests.sh bat
bash run_tests.sh bird
bash run_tests.sh insect
bash run_tests.sh bee
bash run_tests.sh soil
bash run_tests.sh water

# Multiple classifiers
bash run_tests.sh bat bird

# Verbose (shows each test name)
bash run_tests.sh -v

# Stop on first failure
bash run_tests.sh -x

# Direct pytest (same result, more options)
.venv/bin/python3 -m pytest tests/ -v
.venv/bin/python3 -m pytest tests/test_bat_pipeline.py -v
```

---

## Test files

| File | Tests | Classifier | Model |
|------|------:|------------|-------|
| `test_pipeline.py` | 8 | Soil (legacy), AudioProcessor | — |
| `test_bat_pipeline.py` | 11 | Bat (BatDetect2) | PyTorch, loaded automatically |
| `test_bee_pipeline.py` | 10 | Bee (BuzzDetect/YAMNet) | TensorFlow, skipped if `external/buzzdetect/` absent |
| `test_bird_pipeline.py` | 12 | Bird (BirdNET) | TFLite, loaded automatically |
| `test_insect_pipeline.py` | 17 | Insect (OpenSoundscape CNN) | Skipped if `models/orthoptera_uk.model` absent |
| `test_soil_pipeline.py` | 16 | Soil (SAI v2) | No model — pure signal maths |
| `test_water_pipeline.py` | 11 | Water (WAI) | No model — pure signal maths |

---

## What each test file covers

### `test_pipeline.py` — 8 tests
Core unit tests for shared components. Runs without any model.

| Test | What it checks |
|------|----------------|
| `test_soil_classifier_detects_above_threshold` | Legacy v1 SAI fires on plain energy when NDSI disabled |
| `test_soil_classifier_silent_audio` | SAI returns no detection on silence |
| `test_soil_v2_rejects_low_frequency_rumble` | SAI v2 NDSI suppresses 60 Hz traffic rumble |
| `test_soil_v2_flags_worm_band_activity` | SAI v2 detects bursty 1 kHz signal (worm band) |
| `test_soil_v2_rejects_propeller_plane` | SAI v2 transient gate rejects continuous broadband noise |
| `test_audio_processor_bandpass` | Bandpass filter removes 100 Hz when floor is 500 Hz |
| `test_audio_processor_resample` | AudioProcessor resamples to target rate correctly |
| `test_audio_capture_queue_drop` | AudioCapture drops oldest chunk when queue is full |

---

### `test_bat_pipeline.py` — 11 tests
End-to-end validation from AudioMoth USB at 384 kHz through BatDetect2.

Signal path: `WAV (384 kHz) → AudioChunk → AudioProcessor (10–120 kHz bandpass) → BatClassifier → Detection`

Real clips used from `output/clips/Brown_Long-eared_Bat/`, `output/clips/Leisler's_Bat/`, `output/clips/Natterer's_Bat/`.

| Test | What it checks |
|------|----------------|
| `test_audiomoth_chunk_format` | AudioChunk is float32, mono, 384 kHz |
| `test_processor_preserves_sample_rate` | No resampling at 384 kHz |
| `test_processor_bandpass_attenuates_low_freq` | 1 kHz tone suppressed >40 dB by 10 kHz high-pass |
| `test_processor_passes_bat_band` | 40 kHz tone passes with <3 dB loss |
| `test_processor_no_nan_or_inf` | Filtered output contains no NaN or Inf |
| `test_silence_gate_skips_inference` | Silent chunk returns [] without calling BatDetect2 |
| `test_real_clip_produces_detection` | Real bat clip (×3 species) produces ≥1 Detection |
| `test_tmp_wav_written_at_capture_rate` | Temp WAV written at 384 kHz, not BatDetect2's 256 kHz |
| `test_white_noise_no_detection` | Gaussian noise at 0.5/0.5 thresholds produces no detection |

Key: `test_tmp_wav_written_at_capture_rate` guards against a time-scale bug — if the temp file were written at BatDetect2's internal 256 kHz rate, call timing would be wrong.

---

### `test_bee_pipeline.py` — 10 tests
BuzzDetect (YAMNet + transfer model) at 16 kHz. Model-dependent tests are skipped if `external/buzzdetect/` is not present.

Signal path: `WAV (16 kHz) → AudioChunk → AudioProcessor (80–1500 Hz bandpass) → BeeClassifier → Detection`

| Test | Requires model | What it checks |
|------|:--------------:|----------------|
| `test_chunk_format` | No | AudioChunk is float32, mono, 16 kHz |
| `test_processor_bandpass_attenuates_outside_range` | No | 30 Hz tone suppressed >30 dB by 80 Hz high-pass |
| `test_processor_passes_bee_buzz_band` | No | 500 Hz tone passes with <3 dB loss |
| `test_processor_no_nan_or_inf` | No | No NaN/Inf in filtered output |
| `test_no_model_returns_empty` | No | Classifier without `load()` returns [] |
| `test_clip_sample_rate` | No | Saved Honey Bee clips are at 16 kHz |
| `test_real_clip_produces_detection` | Yes | Real clip produces ≥1 Detection with correct metadata |
| `test_silence_returns_empty` | Yes | All-zeros chunk returns [] |
| `test_white_noise_no_detection` | Yes | Low-level Gaussian noise produces no detection |
| `test_report_cooldown_default` | No | `report_cooldown_secs` is a float ≥ 0 |

Note: the bandpass test uses 30 Hz, not 50 Hz. At 16 kHz sample rate with an 80 Hz cutoff, 5th-order Butterworth only gives ~22 dB at 50 Hz; 30 Hz gives ~42 dB, safely past the >30 dB threshold.

---

### `test_bird_pipeline.py` — 12 tests
BirdNET TFLite at 48 kHz. No bandpass applied — BirdNET operates on the full spectrum.

Signal path: `WAV (48 kHz) → AudioChunk → AudioProcessor (passthrough) → BirdClassifier → Detection`

Real clips used from `output/clips/Eurasian_Blue_Tit/`, `output/clips/Eurasian_Blackbird/`, `output/clips/Common_Swift/`, `output/clips/Common_Chiffchaff/`.

| Test | What it checks |
|------|----------------|
| `test_chunk_format` | AudioChunk is float32, mono, 48 kHz |
| `test_processor_no_bandpass_applied` | Passthrough processor preserves RMS within 1% |
| `test_processor_no_nan_or_inf` | No NaN/Inf in processor output |
| `test_silence_gate_skips_inference` | Silent chunk returns [] without calling BirdNET |
| `test_exclude_species_filters_noise_classes` | `_exclude` set contains all 5 BirdNET noise pseudo-classes |
| `test_tmp_wav_written_at_48khz` | Temp WAV is mono at 48 kHz |
| `test_real_clip_produces_detection` | Real clip (×4 species) produces ≥1 Detection with `scientific_name` |
| `test_white_noise_no_detection` | Gaussian noise produces no detection at min_confidence=0.7 |
| `test_cleanup_removes_tmp_file` | `cleanup()` deletes the temp WAV from /dev/shm |

Note on the noise test: BirdNET can return low-confidence scores on any audio. The test uses 0.7 (not 0.5) because BirdNET is known to occasionally score unstructured noise in the 0.5–0.6 range. The production threshold is 0.5 which is appropriate for real-world audio with continuous background.

---

### `test_insect_pipeline.py` — 17 tests
OpenSoundscape CNN (epoch 4/30) at 44.1 kHz with a consecutive-hit confirmation gate.

Signal path: `WAV (44.1 kHz) → AudioChunk → AudioProcessor (3.5–20 kHz bandpass) → InsectClassifier (confirm_chunks gate) → Detection`

Real clips used from: `output/clips/Field_Cricket/`, `Field_Grasshopper/`, `Meadow_Grasshopper/`, `Great_Green_Bush-cricket/`, `Dark_Bush-cricket/`, `Common_Green_Grasshopper/`.

| Test | Requires model | What it checks |
|------|:--------------:|----------------|
| `test_insect_chunk_format` | No | AudioChunk is float32, mono, 44.1 kHz |
| `test_processor_preserves_sample_rate` | No | No resampling, length unchanged |
| `test_processor_attenuates_low_freq` | No | 500 Hz suppressed >30 dB by 3.5 kHz high-pass |
| `test_processor_passes_grasshopper_band` | No | 5 kHz passes with <3 dB loss |
| `test_processor_no_nan_or_inf` | No | No NaN/Inf in filtered output |
| `test_silence_gate_skips_inference` | Yes | Silent chunk returns [], clears hit counters |
| `test_confirm_chunks_requires_consecutive_hits` | Yes | First chunk with confirm_chunks=2 returns [] |
| `test_confirm_chunks_resets_on_miss` | Yes | Hit counter resets to 0 after a missed chunk |
| `test_confirm_chunks_one_fires_immediately` | Yes | confirm_chunks=1 reports on first hit |
| `test_real_clip_produces_detection` | Yes | Real clip (×6 species) produces ≥1 Detection |
| `test_detection_metadata_group_label` | Yes | `group` field is Grasshopper/Bush Cricket/Cricket/Orthoptera |
| `test_white_noise_no_detection` | Yes | confirm_chunks=2 suppresses single noisy chunk |

Key: the `confirm_chunks` tests document a critical gate in the production pipeline. Real stridulation is sustained (multiple chunks); one-shot noise spikes are filtered. The silence gate must clear `_hit_count` — a bug where it returned `[]` without clearing was caught and fixed by these tests.

---

### `test_soil_pipeline.py` — 16 tests
SAI v2 (Soil Acoustic Index) — pure signal maths, no ML model. Runs at 22050 Hz.

SAI v2 formula: `ndsi_01 × bio_rms_norm × transient_gate` (multiplicative — any term at 0 kills the score).

Signal path: `WAV (22050 Hz) → AudioChunk → AudioProcessor (50 Hz–2 kHz bandpass) → SoilClassifier → Detection`

Real clips used from `output/clips/Soil_Activity_—_High/` and `output/clips/Soil_Activity_—_Moderate/`.

| Test | What it checks |
|------|----------------|
| `test_chunk_format` | AudioChunk is float32, mono, 22050 Hz |
| `test_processor_bandpass_attenuates_below_50hz` | 20 Hz tone suppressed by 50 Hz high-pass |
| `test_processor_passes_bio_band` | 1 kHz tone passes with <3 dB loss |
| `test_processor_no_nan_or_inf` | No NaN/Inf in filtered output |
| `test_silence_returns_empty` | Silent chunk returns [] |
| `test_sai_v2_components_present` | Detection metadata has ndsi, bio_rms, transient_gate |
| `test_high_activity_clip_detects` | High-activity clips (×3) each produce ≥1 Detection |
| `test_moderate_activity_clip_detects` | Moderate-activity clips (×3) each produce ≥1 Detection |
| `test_ndsi_positive_for_bio_signal` | Bursty 1 kHz signal gives NDSI > 0 |
| `test_ndsi_negative_for_rumble` | Continuous 60 Hz hum gives NDSI < 0 |
| `test_transient_gate_high_for_bursty` | Bursty 1 kHz gives transient_gate > 0.5 |
| `test_transient_gate_low_for_continuous` | Continuous tone gives transient_gate < 0.5 |

---

### `test_water_pipeline.py` — 11 tests
WAI (Water Acoustic Index) — pure signal maths, no ML model. Runs at 44100 Hz. No real water clips; all synthetic signals.

WAI formula: `ndwi_01 × bio_rms_norm × aci_01` (multiplicative).

Signal path: `WAV (44100 Hz) → AudioChunk → AudioProcessor (10 Hz–8 kHz bandpass + 50 Hz notch) → WaterClassifier → Detection`

| Test | What it checks |
|------|----------------|
| `test_chunk_format` | AudioChunk is float32, mono, 44100 Hz |
| `test_processor_bandpass_attenuates_below_10hz` | Sub-10 Hz infrasound suppressed by high-pass |
| `test_processor_passes_fish_call_band` | 300 Hz (fish chorus range) passes with <3 dB loss |
| `test_processor_no_nan_or_inf` | No NaN/Inf in filtered output |
| `test_wai_components_present` | Detection metadata has ndwi, bio_rms, aci |
| `test_ndwi_positive_for_bio_signal` | Bursty 1 kHz signal gives NDWI > 0 |
| `test_ndwi_negative_for_anthro_noise` | Continuous 75 Hz gives NDWI < 0 |
| `test_mains_notch_reduces_50hz_contamination` | 50 Hz + 1 kHz mix: after notch, NDWI improves |
| `test_bio_signal_above_threshold` | Realistic 300–1500 Hz bio signal produces a detection |
| `test_silence_below_threshold` | Silence returns [] |
| `test_report_cooldown_set` | `report_cooldown_secs` is configured and ≥ 0 |

---

## Real clips required

Tests that use real clips will `pytest.skip()` gracefully if the clips directory is empty. The full set needed for all parametrized tests:

| Classifier | Required clip folders |
|------------|----------------------|
| Bat | `output/clips/Brown_Long-eared_Bat/`, `Leisler's_Bat/`, `Natterer's_Bat/` |
| Bird | `output/clips/Eurasian_Blue_Tit/`, `Eurasian_Blackbird/`, `Common_Swift/`, `Common_Chiffchaff/` |
| Insect | `output/clips/Field_Cricket/`, `Field_Grasshopper/`, `Meadow_Grasshopper/`, `Great_Green_Bush-cricket/`, `Dark_Bush-cricket/`, `Common_Green_Grasshopper/` |
| Bee | `output/clips/Honey_Bee/` |
| Soil | `output/clips/Soil_Activity_—_High/`, `Soil_Activity_—_Moderate/` |
| Water | None — all synthetic |

Clips accumulate in `output/clips/` during normal operation. If a folder is missing, only the parametrized detection test for that species/category is skipped — all other tests in the file still run.

---

## Adding tests for a new species or classifier

**New species detected** — add the clip folder name to the parametrize list in the relevant test file. Example for bat:

```python
BAT_CLIP_DIRS = ["Brown_Long-eared_Bat", "Leisler's_Bat", "Natterer's_Bat", "Common_Pipistrelle"]
```

**New classifier** — copy the structure from the closest existing file (e.g. `test_water_pipeline.py` for index-based classifiers, `test_bat_pipeline.py` for model-based classifiers). Cover at minimum:
1. Chunk format (sample rate, dtype, ndim)
2. AudioProcessor bandpass — one attenuation test, one passband test, NaN/Inf check
3. Silence gate returns []
4. At least one real-clip detection test (parametrized if multiple species)
5. White-noise or unstructured-noise false-positive check

Run with `bash run_tests.sh <classifier_name>` once the file is in place.
