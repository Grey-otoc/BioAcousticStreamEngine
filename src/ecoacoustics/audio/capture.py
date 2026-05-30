"""
Live microphone audio capture with a bounded, thread-safe chunk queue.

Wraps sounddevice.InputStream and accumulates raw PCM samples into fixed-
duration AudioChunk objects that downstream classifiers consume.  The queue
is bounded so that if a classifier runs slower than real time, old chunks
are dropped rather than consuming unbounded memory.

Author: David Green, Blenheim Palace
"""

import logging
import os
import queue
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Optional

import numpy as np

_log = logging.getLogger(__name__)


_PIPEWIRE_PREFIXES = ("alsa_input.", "alsa_output.", "bluez_", "alsa_card.")

# Cached result of the parec availability check (None = not yet checked).
_PAREC_AVAILABLE: Optional[bool] = None


def _parec_available() -> bool:
    """Return True if parec is installed and supports --raw output.

    Result is cached after the first call so subsequent captures don't pay the
    subprocess overhead.  parec (from pulseaudio-utils) is always present on
    Ubuntu/Debian with PipeWire + PA compatibility installed.
    """
    global _PAREC_AVAILABLE
    if _PAREC_AVAILABLE is None:
        try:
            r = subprocess.run(["parec", "--version"], capture_output=True, timeout=3)
            _PAREC_AVAILABLE = r.returncode == 0
        except (FileNotFoundError, subprocess.SubprocessError):
            _PAREC_AVAILABLE = False
        if _PAREC_AVAILABLE:
            _log.info(
                "AudioCapture: parec available — each PipeWire capture runs in its own "
                "subprocess (isolated PA context, no PULSE_SOURCE race)"
            )
        else:
            _log.warning(
                "AudioCapture: parec not found — falling back to PULSE_SOURCE env var "
                "(simultaneous multi-source capture may behave unexpectedly)"
            )
    return _PAREC_AVAILABLE


# Only used as a last-resort fallback when parec is unavailable.
_PULSE_SOURCE_LOCK = threading.Lock()


def _resolve_device(device) -> "tuple[object, Optional[str]]":
    """Translate a device identifier to (sd_device, pulse_source).

    Returns a 2-tuple:
      sd_device    — value to pass as ``device=`` to sounddevice.InputStream,
                     or the string "parec" when the caller should use parec mode.
      pulse_source — PipeWire source name, or None.

    When pulse_source is not None and parec is available, the caller should use
    ``_start_parec(pulse_source)`` rather than opening a sounddevice stream.
    When parec is unavailable, the caller must hold _PULSE_SOURCE_LOCK across
    the os.environ write and sd.InputStream() call.
    """
    if device is None:
        return None, None

    import sounddevice as sd

    if isinstance(device, int):
        try:
            if 0 <= device < len(sd.query_devices()):
                return device, None
        except Exception:
            pass
        # Treat as a PipeWire source numeric ID — resolve to name via pactl
        try:
            out = subprocess.check_output(
                ["pactl", "list", "short", "sources"], text=True, timeout=5
            )
            for line in out.splitlines():
                parts = line.split("\t")
                if len(parts) >= 2 and parts[0].strip() == str(device):
                    device = parts[1].strip()
                    _log.info("AudioCapture: resolved PipeWire source %d → %s", int(parts[0]), device)
                    break
            else:
                _log.warning("AudioCapture: PipeWire source %d not found; using system default", device)
                return None, None
        except Exception as exc:
            _log.warning("AudioCapture: pactl lookup failed (%s); using system default", exc)
            return None, None

    # device is now a string
    if isinstance(device, str) and any(device.startswith(p) for p in _PIPEWIRE_PREFIXES):
        # Signal to the caller that this needs source-specific routing.
        # Preferred path: parec subprocess (own PA context per capture).
        # Fallback path: pulse + PULSE_SOURCE env var under _PULSE_SOURCE_LOCK.
        return "pulse", device

    return device, None

# How many 3-second chunks to buffer before dropping. At 3s/chunk this is
# ~60s of headroom for the classifier to catch up before we start losing audio.
MAX_QUEUE_SIZE = 20


@dataclass
class AudioChunk:
    """A fixed-duration slice of mono float32 audio from the microphone.

    Attributes:
        data: PCM samples as float32, shape (n_samples,).
        sample_rate: Samples per second (e.g. 48000).
        timestamp: Unix epoch time at which the chunk was captured.
    """

    data: np.ndarray
    sample_rate: int
    timestamp: float


class AudioCapture:
    """Streams audio from a microphone into a thread-safe bounded queue.

    A sounddevice InputStream callback accumulates incoming PCM frames into
    an internal rolling buffer. Whenever the buffer contains enough samples
    for a complete chunk (sample_rate × chunk_duration), an AudioChunk is
    enqueued for the classifier threads to consume via get_chunk().

    If the queue is full (classifier is too slow), the incoming chunk is
    silently discarded and the dropped_chunks counter is incremented.  The
    Watchdog monitors this counter and warns the operator.
    """

    def __init__(
        self,
        sample_rate: int,
        chunk_duration: float,
        device: Optional[int | str] = None,
        channels: int = 1,
        max_queue_size: int = MAX_QUEUE_SIZE,
    ):
        """
        Args:
            sample_rate: Target sample rate in Hz (e.g. 48000 for BirdNET).
            chunk_duration: Length of each analysis window in seconds.
            device: sounddevice device index or name; None uses the system default.
            channels: Number of input channels (mono recordings use 1).
            max_queue_size: Maximum chunks held in the queue before dropping begins.
        """
        self.sample_rate = sample_rate
        self.chunk_samples = int(sample_rate * chunk_duration)
        self.device = device
        self.channels = channels

        self._queue_capacity = max_queue_size
        self._subscribers: list[queue.Queue[AudioChunk]] = []
        self._subscriber_lock = threading.Lock()
        self._buffer = np.zeros(0, dtype=np.float32)
        self._lock = threading.Lock()

        # sounddevice stream (used when device is a direct ALSA index or name)
        self._stream = None
        # parec subprocess (used when device is a PipeWire source name)
        self._proc: Optional[subprocess.Popen] = None
        self._proc_thread: Optional[threading.Thread] = None

        self._dropped: int = 0          # chunks discarded when a subscriber queue was full
        self._last_chunk_time: float = 0.0
        self._started_at: float = 0.0   # unix time when stream was last opened
        self._overflow_count: int = 0   # sounddevice input overflow events
        self._chunk_start_time: float = 0.0  # wall time when current chunk accumulation began
        self._last_rms: float = 0.0     # RMS of the most recent callback frame
        self._last_nonsilent_time: float = 0.0  # last time RMS exceeded silence floor

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def start(self) -> None:
        """Open the audio input, retrying up to 3 times on transient errors.

        For PipeWire-named sources (alsa_input.*) parec is used as a subprocess
        so each capture has its own isolated PA context — no PULSE_SOURCE race.
        For direct device indices / ALSA names sounddevice is used as before.
        """
        _, pulse_source = _resolve_device(self.device)

        if pulse_source is not None and _parec_available():
            self._start_parec(pulse_source)
        else:
            self._start_sounddevice(pulse_source)

    def _start_sounddevice(self, pulse_source: Optional[str]) -> None:
        """Open a sounddevice InputStream, with PULSE_SOURCE lock when needed."""
        import sounddevice as sd
        resolved_device, _ = _resolve_device(self.device)
        last_exc: Optional[Exception] = None
        for attempt in range(3):
            try:
                def _open():
                    self._stream = sd.InputStream(
                        samplerate=self.sample_rate,
                        channels=self.channels,
                        dtype="float32",
                        device=resolved_device,
                        callback=self._callback,
                    )
                    self._stream.start()

                if pulse_source is not None:
                    with _PULSE_SOURCE_LOCK:
                        os.environ["PULSE_SOURCE"] = pulse_source
                        _open()
                else:
                    _open()

                self._last_chunk_time = 0.0
                self._chunk_start_time = 0.0
                self._last_nonsilent_time = 0.0
                self._started_at = time.time()
                return
            except Exception as exc:
                last_exc = exc
                if self._stream:
                    try:
                        self._stream.close()
                    except Exception:
                        pass
                    self._stream = None
                if attempt < 2:
                    time.sleep(0.5 * (attempt + 1))
        raise last_exc  # type: ignore[misc]

    def _start_parec(self, source_name: str) -> None:
        """Spawn a parec subprocess targeting a specific PipeWire source.

        Each call creates a fresh OS process with its own PipeWire client
        connection, so two captures on different sources never share state
        and there is no PULSE_SOURCE race condition.
        """
        last_exc: Optional[Exception] = None
        for attempt in range(3):
            proc = None
            try:
                proc = subprocess.Popen(
                    [
                        "parec",
                        f"--device={source_name}",
                        f"--rate={self.sample_rate}",
                        f"--channels={self.channels}",
                        "--format=float32le",
                        "--raw",
                        "--latency-msec=500",
                    ],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    bufsize=0,
                )
                # Brief pause to catch immediate failures (bad source name, etc.)
                time.sleep(0.4)
                if proc.poll() is not None:
                    err = proc.stderr.read(300).decode(errors="replace").strip()
                    raise RuntimeError(f"parec exited immediately: {err}")

                self._proc = proc
                self._proc_thread = threading.Thread(
                    target=self._parec_reader_loop,
                    args=(proc,),
                    daemon=True,
                    name=f"parec/{source_name[-20:]}",
                )
                self._proc_thread.start()
                self._last_chunk_time = 0.0
                self._chunk_start_time = 0.0
                self._last_nonsilent_time = 0.0
                self._started_at = time.time()
                _log.info("AudioCapture: parec started for '%s' at %d Hz", source_name, self.sample_rate)
                return
            except Exception as exc:
                last_exc = exc
                if proc is not None:
                    try:
                        proc.kill()
                        proc.wait(timeout=2)
                    except Exception:
                        pass
                self._proc = None
                if attempt < 2:
                    time.sleep(0.5 * (attempt + 1))
        raise last_exc  # type: ignore[misc]

    def _parec_reader_loop(self, proc: subprocess.Popen) -> None:
        """Read raw float32le PCM from parec stdout; deliver AudioChunks to subscribers.

        Runs in a daemon thread.  Exits cleanly when parec closes its stdout
        (process ended or killed).  The Watchdog detects the resulting stale
        last_chunk_time and calls restart().
        """
        bytes_per_frame = 4 * self.channels  # float32 × channels
        chunk_bytes = self.chunk_samples * bytes_per_frame
        read_block = max(chunk_bytes // 8, 4096)  # ~1/8-chunk reads keep latency low
        buf = bytearray()
        chunk_wall_time: float = 0.0

        try:
            while True:
                data = proc.stdout.read(read_block)
                if not data:
                    _log.info("AudioCapture: parec stdout closed (%s)", proc.args[1] if len(proc.args) > 1 else "?")
                    break
                buf.extend(data)
                now = time.time()

                while len(buf) >= chunk_bytes:
                    raw = bytes(buf[:chunk_bytes])
                    del buf[:chunk_bytes]

                    audio = np.frombuffer(raw, dtype="<f4")
                    if self.channels > 1:
                        audio = audio.reshape(-1, self.channels).mean(axis=1).astype(np.float32)

                    rms = float(np.sqrt(np.mean(audio ** 2)))
                    self._last_rms = rms
                    if rms > 1e-6:
                        self._last_nonsilent_time = now

                    if chunk_wall_time == 0.0:
                        # Back-date to the start of this chunk's capture window.
                        chunk_wall_time = now - (self.chunk_samples / self.sample_rate)

                    chunk = AudioChunk(
                        data=audio.copy(),
                        sample_rate=self.sample_rate,
                        timestamp=chunk_wall_time,
                    )
                    chunk_wall_time += self.chunk_samples / self.sample_rate
                    self._last_chunk_time = now

                    with self._subscriber_lock:
                        subs = list(self._subscribers)
                    for sub_q in subs:
                        try:
                            sub_q.put_nowait(chunk)
                        except queue.Full:
                            self._dropped += 1

        except Exception as exc:
            _log.warning("AudioCapture: parec reader error: %s", exc)

    def stop(self) -> None:
        """Stop the audio stream (sounddevice or parec) and drain queues.

        Draining ensures no stale audio from the previous session is processed
        after a restart.
        """
        # sounddevice path
        if self._stream:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
            self._stream = None

        # parec subprocess path
        if self._proc:
            try:
                self._proc.terminate()
                try:
                    self._proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self._proc.kill()
                    self._proc.wait(timeout=1)
            except Exception:
                pass
            self._proc = None
        # _proc_thread is daemon; it exits when parec stdout closes after kill.

        with self._subscriber_lock:
            subs = list(self._subscribers)
        total_drained = 0
        for q in subs:
            while not q.empty():
                try:
                    q.get_nowait()
                    total_drained += 1
                except queue.Empty:
                    break
        if total_drained:
            _log.debug("AudioCapture.stop: drained %d stale chunks", total_drained)
        self._started_at = 0.0

    def restart(self) -> None:
        """Stop the stream, drain stale queued audio, then restart.

        Called by the Watchdog when the stream appears to have gone silent
        unexpectedly (e.g. USB microphone briefly disconnected).
        stop() now handles queue draining, so we just reset the buffer and reopen.
        """
        self.stop()
        with self._lock:
            self._buffer = np.zeros(0, dtype=np.float32)
        time.sleep(1.0)
        self.start()

    def subscribe(self, max_queue_size: int = None) -> "queue.Queue[AudioChunk]":
        """Register a new consumer; returns a dedicated queue fed by every chunk.

        Each subscriber receives an independent copy of every audio chunk, so
        multiple classifiers sharing the same physical device each get the full
        audio stream rather than racing over a single shared queue.
        """
        q: queue.Queue[AudioChunk] = queue.Queue(maxsize=max_queue_size or self._queue_capacity)
        with self._subscriber_lock:
            self._subscribers.append(q)
        return q

    @staticmethod
    def list_devices() -> None:
        """Print all available audio input/output devices to stdout."""
        import sounddevice as sd
        print(sd.query_devices())

    # ------------------------------------------------------------------
    # Health properties (read by Watchdog)
    # ------------------------------------------------------------------

    @property
    def is_active(self) -> bool:
        """True if the capture is running (sounddevice stream or parec subprocess)."""
        if self._stream is not None:
            return self._stream.active
        if self._proc is not None:
            return self._proc.poll() is None
        return False

    @property
    def started_at(self) -> float:
        """Unix timestamp when the stream was last opened; 0 before first start."""
        return self._started_at

    @property
    def queue_depth(self) -> int:
        """Maximum depth across all subscriber queues."""
        with self._subscriber_lock:
            subs = list(self._subscribers)
        return max((q.qsize() for q in subs), default=0)

    @property
    def queue_capacity(self) -> int:
        """Maximum number of chunks the queue can hold before dropping."""
        return self._queue_capacity

    @property
    def dropped_chunks(self) -> int:
        """Cumulative count of chunks discarded due to a full queue."""
        return self._dropped

    @property
    def last_chunk_time(self) -> float:
        """Unix timestamp of the most recently enqueued chunk; 0 before first chunk."""
        return self._last_chunk_time

    @property
    def overflow_count(self) -> int:
        """Number of sounddevice input-overflow events since stream start."""
        return self._overflow_count

    @property
    def last_rms(self) -> float:
        """RMS amplitude of the most recently received audio frame (updated every callback)."""
        return self._last_rms

    @property
    def last_nonsilent_time(self) -> float:
        """Unix timestamp of the last callback frame with RMS above the silence floor.

        Stays 0.0 until the stream produces its first non-silent frame.  The
        Watchdog uses this to detect when PipeWire is delivering silence for a
        disconnected device (the stream stays "active" but all samples are zero).
        """
        return self._last_nonsilent_time

    # ------------------------------------------------------------------
    # Internal callback (runs in sounddevice thread)
    # ------------------------------------------------------------------

    def _callback(self, indata: np.ndarray, frames: int, time_info, status) -> None:
        """Accumulate incoming PCM frames and emit complete chunks to the queue.

        Runs in the sounddevice audio thread — must not block.

        chunk.timestamp is the wall-clock time of the FIRST sample in the chunk
        (i.e. when the recording window opened), so detections are logged against
        when the animal called, not when the classifier finished processing.
        """
        if status.input_overflow:
            self._overflow_count += 1

        mono = indata[:, 0] if indata.ndim > 1 else indata.ravel()
        self._last_rms = float(np.sqrt(np.mean(mono ** 2)))
        now = time.time()
        # Track last non-silent frame so the watchdog can detect PipeWire silence-fill
        # after a device disconnect (stream stays active but delivers exact zeros).
        if self._last_rms > 1e-6:
            self._last_nonsilent_time = now

        ready_chunks: list[AudioChunk] = []
        with self._lock:
            if len(self._buffer) == 0:
                # First samples of a new chunk — record the wall time of this moment.
                self._chunk_start_time = now

            self._buffer = np.concatenate([self._buffer, mono])
            while len(self._buffer) >= self.chunk_samples:
                chunk_data = self._buffer[: self.chunk_samples].copy()
                self._buffer = self._buffer[self.chunk_samples :]
                ready_chunks.append(AudioChunk(
                    data=chunk_data,
                    sample_rate=self.sample_rate,
                    timestamp=self._chunk_start_time,
                ))
                # Advance start time for any back-to-back chunks extracted in
                # the same callback (rare, but possible on large frame sizes).
                self._chunk_start_time += self.chunk_samples / self.sample_rate

        # Fan-out each completed chunk to every registered subscriber queue.
        # This runs outside the buffer lock so a slow put() never stalls the audio thread.
        if ready_chunks:
            with self._subscriber_lock:
                subs = list(self._subscribers)
            for chunk in ready_chunks:
                for sub_q in subs:
                    try:
                        sub_q.put_nowait(chunk)
                    except queue.Full:
                        # Subscriber is too slow — drop rather than blocking the audio thread.
                        self._dropped += 1
            self._last_chunk_time = now  # wall clock for watchdog stale check
