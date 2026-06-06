"""Server-side spectrogram — streams FFT magnitude data from a PipeWire source as SSE.

The browser's getUserMedia cannot reliably map PipeWire source names to browser
deviceIds when two USB devices share the same model label.  This endpoint sidesteps
that entirely: the server runs parec against the named PipeWire source directly,
computes the FFT, and streams 0-255 magnitude arrays as Server-Sent Events.

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

_FFT_SIZE = 2048
_SAMPLE_RATE = 48000
_BINS = _FFT_SIZE // 2                        # 1024 frequency bins sent to client
_HANN = np.hanning(_FFT_SIZE).astype(np.float32)

# Match AnalyserNode defaults: minDecibels=-100, maxDecibels=-30
_DB_MIN = -100.0
_DB_RANGE = 70.0   # -30 - (-100)


@router.get("/spectrogram/stream")
async def spectrogram_stream(device: str = Query("", description="PipeWire source name")):
    """Capture audio from a named PipeWire source and stream FFT magnitudes as SSE.

    Each message is ``data: [b0, b1, …, b1023]\\n\\n`` where each value is 0-255,
    normalised identically to the Web Audio AnalyserNode getByteFrequencyData output.
    """

    async def generate():
        cmd = ["parec", "--format=s16le", "--channels=1", f"--rate={_SAMPLE_RATE}"]
        if device:
            cmd += [f"--device={device}"]

        proc = None
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            bytes_per_frame = _FFT_SIZE * 2  # 16-bit = 2 bytes per sample

            while True:
                try:
                    raw = await proc.stdout.readexactly(bytes_per_frame)
                except asyncio.IncompleteReadError:
                    break   # parec exited (device removed / stopped)

                samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                # Divide by FFT_SIZE to match AnalyserNode getByteFrequencyData normalisation
                fft_mag = np.abs(np.fft.rfft(samples * _HANN))[:_BINS] / _FFT_SIZE

                fft_db = 20.0 * np.log10(np.maximum(fft_mag, 1e-10))
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
