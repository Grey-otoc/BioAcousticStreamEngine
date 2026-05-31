"""
Background health monitor for continuous field deployment.

The Watchdog runs as a daemon thread alongside the classifier threads and
performs periodic health checks to catch and recover from common failure
modes without operator intervention:

  Queue depth monitoring
      If a classifier is running slower than real time, the bounded audio
      queue fills up and chunks are dropped.  The Watchdog warns at 60%
      and 90% capacity and reports dropped-chunk deltas each cycle so the
      operator can tune the system or upgrade hardware.

  Stream stale detection and restart
      If a capture stream produces no new chunks for more than 20 seconds,
      the microphone is assumed to have disconnected or crashed.  The Watchdog
      calls capture.restart() which re-opens the sounddevice stream and drains
      stale queued audio before resuming.

  Disk space monitoring and emergency cleanup
      Clips and CSV logs accumulate over time.  If free disk space falls below
      500 MB a warning is printed; below 150 MB the ClipManager's emergency
      cleanup routine is invoked to remove the lowest-confidence clips across
      all species until the disk is freed.

  Periodic status heartbeat
      Every 5 minutes a one-line status summary is printed showing queue
      depths, free disk space, and total species seen.  This confirms to the
      operator that the process is alive without flooding the terminal.

Author: David Green, Blenheim Palace
"""

import shutil
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING

from rich.console import Console

if TYPE_CHECKING:
    from ecoacoustics.audio.capture import AudioCapture
    from ecoacoustics.clip_manager import ClipManager

_console = Console()

CHECK_INTERVAL = 30       # seconds between each health check cycle
STATUS_INTERVAL = 300     # seconds between periodic status heartbeat prints
STREAM_STALE_SECS = 20    # silence duration that triggers a stream restart
DISK_WARNING_MB = 500     # free space level that triggers a console warning
DISK_CRITICAL_MB = 150    # free space level that triggers emergency cleanup


class Watchdog(threading.Thread):
    """Daemon thread that monitors system health and recovers from failures.

    Runs independently of the classifier threads.  All recovery actions
    (stream restart, emergency cleanup) are logged to the console so the
    operator is always aware of what corrective action was taken.
    """

    def __init__(
        self,
        captures: "dict[tuple, AudioCapture]",
        clip_manager: "ClipManager",
        stop_event: threading.Event,
        clips_dir: str = "output/clips",
    ):
        """
        Args:
            captures: Dict mapping (sample_rate, device) → AudioCapture, same as in Pipeline.
            clip_manager: The active ClipManager instance (for emergency cleanup).
            stop_event: Threading event shared with the Pipeline; set to stop the loop.
            clips_dir: Path to the clips directory (used for disk-space checks).
        """
        super().__init__(daemon=True, name="watchdog")
        self._captures = captures
        self._clip_manager = clip_manager
        self._stop = stop_event
        self._clips_dir = Path(clips_dir)

        # Baseline dropped-chunk counts per stream for delta reporting
        self._last_dropped: dict = {k: 0 for k in captures}
        self._last_status_time = time.time()
        # Restart failure tracking: exponential backoff when a device is gone
        self._restart_failures: dict[tuple, int] = {k: 0 for k in captures}
        self._next_restart_allowed: dict[tuple, float] = {}

    # ------------------------------------------------------------------
    # Thread entry point
    # ------------------------------------------------------------------

    def run(self) -> None:
        """Main loop: check health every CHECK_INTERVAL seconds until stopped."""
        while not self._stop.wait(CHECK_INTERVAL):
            try:
                self._check_queues()
                self._check_streams()
                self._check_disk()
                self._maybe_print_status()
            except Exception as exc:
                _console.print(f"[red][watchdog] unexpected error: {exc}[/red]")

    # ------------------------------------------------------------------
    # Health checks
    # ------------------------------------------------------------------

    @staticmethod
    def _stream_label(key) -> str:
        """Human-readable label for a capture key, e.g. '48000Hz/built-in'."""
        if isinstance(key, tuple) and len(key) >= 2:
            sr, dev = key[0], key[1]
            dev_str = str(dev)
            if "usb-" in dev_str:
                short = "usb-mic"
            elif "pci-" in dev_str or "analog" in dev_str:
                short = "built-in"
            elif dev_str in ("pulse", "pipewire", "default", "None", "none"):
                short = "default"
            else:
                short = dev_str.split(".")[-1][:16]
            return f"{sr}Hz/{short}"
        return f"{key}Hz"

    def _check_queues(self) -> None:
        """Warn if any audio queue is filling up or dropping chunks."""
        for key, capture in self._captures.items():
            label = self._stream_label(key)
            depth = capture.queue_depth
            cap = capture.queue_capacity
            pct = depth / cap if cap else 0

            if pct >= 0.9:
                _console.print(
                    f"[bold red][watchdog] {label} queue critical "
                    f"({depth}/{cap}) — processing can't keep up[/bold red]"
                )
            elif pct >= 0.6:
                _console.print(
                    f"[yellow][watchdog] {label} queue filling "
                    f"({depth}/{cap} slots used)[/yellow]"
                )

            new_dropped = capture.dropped_chunks
            delta = new_dropped - self._last_dropped.get(key, 0)
            if delta > 0:
                _console.print(
                    f"[yellow][watchdog] {label} dropped {delta} chunk(s) "
                    f"(total {new_dropped}) — classifier is slower than real-time[/yellow]"
                )
            self._last_dropped[key] = new_dropped

    def _check_streams(self) -> None:
        """Restart any audio stream that has gone stale or is delivering silence.

        Two failure modes are detected:
        1. No chunks received for STREAM_STALE_SECS — stream callback has stopped
           (device hard-disconnected or crashed).
        2. Chunks arriving but RMS is at the silence floor for STREAM_STALE_SECS —
           PipeWire is delivering zeros to keep the stream alive after a device unplug
           rather than terminating it.
        """
        now = time.time()
        for key, capture in self._captures.items():
            label = self._stream_label(key)
            last = capture.last_chunk_time
            reference = last if last > 0.0 else capture.started_at
            if reference == 0.0:
                continue  # stream hasn't been opened yet

            needs_restart = False
            reason = ""

            stale = now - reference
            if stale > STREAM_STALE_SECS:
                needs_restart = True
                reason = "no chunks ever received" if last == 0.0 else f"no chunks for {stale:.0f}s"
            else:
                # Stream is delivering chunks — check if they contain any real signal.
                # PipeWire fills with exact zeros when the source device is unplugged.
                nonsilent = capture.last_nonsilent_time
                started = capture.started_at
                # Reference for silence: last non-silent frame, or stream start if none yet
                silence_ref = nonsilent if nonsilent > 0.0 else started
                stream_age = now - started if started > 0.0 else 0.0
                # Only trigger after stream has had time to produce audio
                if stream_age > STREAM_STALE_SECS and silence_ref > 0.0:
                    silent_for = now - silence_ref
                    if silent_for > STREAM_STALE_SECS:
                        needs_restart = True
                        reason = f"delivering silence for {silent_for:.0f}s — device may have disconnected"

            if needs_restart:
                if now < self._next_restart_allowed.get(key, 0.0):
                    continue  # still within backoff window — skip this cycle
                _console.print(
                    f"[yellow][watchdog] {label} stale ({reason}) "
                    f"— attempting restart[/yellow]"
                )
                try:
                    capture.restart()
                    _console.print(f"[green][watchdog] {label} restarted successfully[/green]")
                    self._restart_failures[key] = 0
                    self._next_restart_allowed.pop(key, None)
                except Exception as exc:
                    n = self._restart_failures.get(key, 0) + 1
                    self._restart_failures[key] = n
                    backoff = min(60 * (2 ** (n - 1)), 600)  # 60 → 120 → 240 → 480 → 600s cap
                    self._next_restart_allowed[key] = now + backoff
                    _console.print(
                        f"[red][watchdog] {label} restart failed ({n}×): {exc} "
                        f"— retrying in {backoff}s[/red]"
                    )

    def _check_disk(self) -> None:
        """Warn on low disk space; trigger emergency cleanup if critical."""
        if not self._clips_dir.exists():
            return
        try:
            usage = shutil.disk_usage(self._clips_dir)
        except OSError:
            return
        free_mb = usage.free // (1024 ** 2)

        if free_mb < DISK_CRITICAL_MB:
            _console.print(
                f"[bold red][watchdog] CRITICAL: only {free_mb}MB free — "
                f"running emergency clip cleanup[/bold red]"
            )
            removed = self._clip_manager.emergency_cleanup(target_free_mb=DISK_WARNING_MB)
            _console.print(f"[yellow][watchdog] emergency cleanup removed {removed} clip(s)[/yellow]")
        elif free_mb < DISK_WARNING_MB:
            _console.print(f"[yellow][watchdog] low disk space: {free_mb}MB free[/yellow]")

    def _maybe_print_status(self) -> None:
        """Print a brief health summary every STATUS_INTERVAL seconds."""
        now = time.time()
        if now - self._last_status_time < STATUS_INTERVAL:
            return
        self._last_status_time = now

        parts = []
        for key, capture in self._captures.items():
            label = self._stream_label(key)
            parts.append(f"{label} q={capture.queue_depth}/{capture.queue_capacity}")
        if self._clips_dir.exists():
            try:
                free_mb = shutil.disk_usage(self._clips_dir).free // (1024 ** 2)
                parts.append(f"disk={free_mb}MB free")
            except OSError:
                pass
        species = self._clip_manager.known_species_count()
        parts.append(f"species_seen={species}")
        _console.print(f"[dim][watchdog] {' | '.join(parts)}[/dim]")
