"""Server-side spectrogram — streams FFT magnitude data from a PipeWire source as SSE.

The browser's getUserMedia cannot reliably map PipeWire source names to browser
deviceIds when two USB devices share the same model label.  This endpoint sidesteps
that entirely: the server runs parec against the named PipeWire source directly,
computes the FFT, and streams 0-255 magnitude arrays as Server-Sent Events.

Design to match AnalyserNode output:
- fftSize = 4096  →  2048 frequency bins (same as browser fftSize=4096)
- 75 % overlap (1024-sample hop) for smooth temporal transitions
- Hann window, same as AnalyserNode Blackman-Harris approximation
- Temporal smoothing τ=0.4, same as AnalyserNode.smoothingTimeConstant default
- dB mapping: minDecibels=-100, maxDecibels=-30, same as AnalyserNode defaults

Author: David Green, Blenheim Palace
"""

import asyncio
import json
import logging

import numpy as np
from fastapi import APIRouter, Query
from starlette.responses import StreamingResponse

router = APIRouter()
_log = logging.getLogger(__name__)

_FFT_SIZE = 4096
_HOP = 1024                                    # 21.3ms at 48kHz → ~47fps
_SAMPLE_RATE = 48000
_BINS = _FFT_SIZE // 2                         # 2048 bins — matches browser frequencyBinCount
_HANN = np.hanning(_FFT_SIZE).astype(np.float32)
_DB_MIN = -100.0
_DB_RANGE = 70.0                               # maxDecibels(-30) - minDecibels(-100)
_SMOOTH = 0.4                                  # AnalyserNode.smoothingTimeConstant default


@router.get("/spectrogram/stream")
async def spectrogram_stream(device: str = Query("", description="PipeWire source name")):
    """Capture audio from a named PipeWire source and stream FFT magnitudes as SSE.

    Each SSE message: ``data: [b0, …, b2047]\\n\\n`` — values 0-255, normalised
    identically to AnalyserNode.getByteFrequencyData() output.
    """

    async def generate():
        cmd = [
            "parec",
            "--format=s16le",
            "--channels=1",
            f"--rate={_SAMPLE_RATE}",
            "--latency-msec=21",   # flush every ~1024 samples to match hop size
        ]
        if device:
            cmd += [f"--device={device}"]

        proc = None
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            bytes_per_hop = _HOP * 2   # 16-bit = 2 bytes per sample

            # Ring buffer: always holds the most recent _FFT_SIZE samples
            buf = np.zeros(_FFT_SIZE, dtype=np.float32)
            # Exponential moving average over FFT magnitudes (temporal smoothing)
            smoothed = np.zeros(_BINS, dtype=np.float32)

            while True:
                try:
                    raw = await proc.stdout.readexactly(bytes_per_hop)
                except asyncio.IncompleteReadError:
                    break   # parec exited (device removed / process stopped)

                new_samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

                # Slide ring buffer: drop oldest _HOP samples, append new ones
                buf[:-_HOP] = buf[_HOP:]
                buf[-_HOP:] = new_samples

                # FFT on full window; divide by FFT size to match AnalyserNode normalisation
                fft_mag = np.abs(np.fft.rfft(buf * _HANN))[:_BINS] / _FFT_SIZE

                # Temporal smoothing — replicates AnalyserNode.smoothingTimeConstant
                smoothed = _SMOOTH * smoothed + (1.0 - _SMOOTH) * fft_mag

                fft_db = 20.0 * np.log10(np.maximum(smoothed, 1e-10))
                fft_norm = np.clip(
                    (fft_db - _DB_MIN) / _DB_RANGE * 255.0, 0.0, 255.0
                ).astype(np.uint8)

                yield f"data: {json.dumps(fft_norm.tolist())}\n\n"

        except asyncio.CancelledError:
            pass
        except FileNotFoundError:
            _log.warning("parec not found — install pulseaudio-utils for server-side spectrogram")
        except Exception as exc:
            _log.warning("Spectrogram SSE error (device=%r): %s", device, exc)
        finally:
            if proc:
                try:
                    proc.kill()
                    await proc.wait()
                except Exception:
                    pass

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
