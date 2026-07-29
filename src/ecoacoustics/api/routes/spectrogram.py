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
import re

import numpy as np
from fastapi import APIRouter, Query
from starlette.responses import StreamingResponse

router = APIRouter()
_log = logging.getLogger(__name__)

_HZ_RE = re.compile(r"\b(\d+)Hz\b")


async def _detect_device_rate(device: str, fallback: int) -> int:
    """Query PipeWire via pactl for the actual sample rate of a named source.

    PipeWire sometimes resamples a high-rate device (e.g. AudioMoth at 384 kHz)
    to the system default (48 kHz) when accessed through a .mono-fallback source.
    Using the detected rate ensures FFT bins are labelled correctly in the browser.
    Falls back to `fallback` if pactl is unavailable or the device isn't listed.
    """
    if not device:
        return fallback
    try:
        proc = await asyncio.create_subprocess_exec(
            "pactl", "list", "short", "sources",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=2.0)
        for line in stdout.decode(errors="replace").splitlines():
            if device in line:
                m = _HZ_RE.search(line)
                if m:
                    detected = int(m.group(1))
                    if detected != fallback:
                        _log.warning(
                            "spectrogram: device '%s' runs at %d Hz, not %d Hz — "
                            "using detected rate for correct frequency labels",
                            device, detected, fallback,
                        )
                    return detected
    except Exception:
        pass
    return fallback

_FFT_SIZE = 4096
_BINS = _FFT_SIZE // 2                         # 2048 bins — matches browser frequencyBinCount
_HANN = np.hanning(_FFT_SIZE).astype(np.float32)
_DB_MIN = -100.0
_DB_RANGE = 70.0                               # maxDecibels(-30) - minDecibels(-100)
_SMOOTH = 0.1    # low: overlap already smooths; 0.4 was double-blurring


@router.get("/spectrogram/stream")
async def spectrogram_stream(
    device: str = Query("", description="PipeWire source name"),
    rate: int = Query(48000, description="Capture sample rate (Hz). Use 384000 for bat."),
):
    """Capture audio from a named PipeWire source and stream FFT magnitudes as SSE.

    Each SSE message: ``data: {"bins": [...], "rate": <int>}\\n\\n`` — bins are 0-255
    magnitudes (2048 values) normalised identically to AnalyserNode.getByteFrequencyData().
    The ``rate`` field reflects the actual device rate (detected from PipeWire) so the
    browser labels frequency bins correctly even when PipeWire resamples.
    """
    # Detect the real device rate before opening the stream.  PipeWire may
    # resample a high-rate device (e.g. AudioMoth 384 kHz) to 48 kHz via its
    # .mono-fallback adapter — using the detected rate keeps the display honest.
    actual_rate = await _detect_device_rate(device, rate)

    async def generate():
        # Hop scales with rate so temporal resolution stays ~21ms regardless of rate.
        # Must not exceed _FFT_SIZE or the ring-buffer assignment overflows.
        hop = min(max(256, int(actual_rate * 0.021)), _FFT_SIZE)

        cmd = [
            "parec",
            "--format=s16le",
            "--channels=1",
            f"--rate={actual_rate}",
            f"--latency-msec={max(10, hop * 1000 // actual_rate)}",
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
            bytes_per_hop = hop * 2   # 16-bit = 2 bytes per sample

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

                # Slide ring buffer: drop oldest hop samples, append new ones
                buf[:-hop] = buf[hop:]
                buf[-hop:] = new_samples

                # FFT on full window; divide by FFT size to match AnalyserNode normalisation
                fft_mag = np.abs(np.fft.rfft(buf * _HANN))[:_BINS] / _FFT_SIZE

                # Temporal smoothing — replicates AnalyserNode.smoothingTimeConstant
                smoothed = _SMOOTH * smoothed + (1.0 - _SMOOTH) * fft_mag

                fft_db = 20.0 * np.log10(np.maximum(smoothed, 1e-10))
                fft_norm = np.clip(
                    (fft_db - _DB_MIN) / _DB_RANGE * 255.0, 0.0, 255.0
                ).astype(np.uint8)

                yield f"data: {json.dumps({'bins': fft_norm.tolist(), 'rate': actual_rate})}\n\n"

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


@router.get("/spectrogram/audio")
async def spectrogram_audio(
    device: str = Query("", description="PipeWire source name"),
    rate: int = Query(48000, description="Capture sample rate (Hz). Use 384000 for bat."),
):
    """Stream raw PCM audio from a named PipeWire source for headphone monitoring.

    Format: signed 16-bit little-endian, mono, <rate> Hz (s16le).
    The browser decodes this via an AudioWorklet and routes it to the speakers.
    For bat mode (rate=384000) the browser decimates by 8 to achieve frequency division
    into the audible range.  A separate parec process is spawned per connection so the
    FFT stream and the audio monitor stream can run independently.
    """

    async def generate():
        cmd = [
            "parec",
            "--format=s16le",
            "--channels=1",
            f"--rate={rate}",
            "--latency-msec=40",   # low latency for monitoring feel
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
            while True:
                chunk = await proc.stdout.read(4096)   # ~42ms chunks at 48kHz
                if not chunk:
                    break
                yield chunk

        except asyncio.CancelledError:
            pass
        except FileNotFoundError:
            _log.warning("parec not found — cannot stream audio for monitoring")
        except Exception as exc:
            _log.warning("Spectrogram audio stream error (device=%r): %s", device, exc)
        finally:
            if proc:
                try:
                    proc.kill()
                    await proc.wait()
                except Exception:
                    pass

    return StreamingResponse(
        generate(),
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "X-Audio-Format": "s16le",
            "X-Audio-Rate": str(rate),
            "X-Audio-Channels": "1",
        },
    )
