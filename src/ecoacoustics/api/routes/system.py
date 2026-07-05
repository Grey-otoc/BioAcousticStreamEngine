"""
System management routes — boot-start toggle and service lifecycle.

Lets the web UI install/remove the systemd user service so new devices
can be configured without touching the command line after the very first
`python -m ecoacoustics.main web` launch.

Author: David Green, Blenheim Palace
"""

import logging
import os
import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter

_log = logging.getLogger(__name__)
router = APIRouter()

_SERVICE_NAME = "bioacoustic-stream-engine"
_SERVICE_FILE = Path.home() / ".config" / "systemd" / "user" / f"{_SERVICE_NAME}.service"


def _service_unit(work_dir: Path, python_exe: Path) -> str:
    return f"""[Unit]
Description=Bioacoustic Stream Engine — web UI
After=network.target pipewire.service pipewire-pulse.service
Wants=pipewire.service pipewire-pulse.service

[Service]
Type=simple
WorkingDirectory={work_dir}
ExecStart={python_exe} -m ecoacoustics.main web --no-browser
Restart=always
RestartSec=10
TimeoutStartSec=60

[Install]
WantedBy=default.target
"""


def _run(*args: str) -> "subprocess.CompletedProcess":
    return subprocess.run(list(args), capture_output=True, text=True, timeout=10)


def _boot_status() -> dict:
    """Return the current boot-start state."""
    installed = _SERVICE_FILE.exists()

    enabled = False
    if installed:
        r = _run("systemctl", "--user", "is-enabled", f"{_SERVICE_NAME}.service")
        enabled = r.stdout.strip() == "enabled"

    linger = False
    r = _run("loginctl", "show-user", os.getenv("USER", ""), "--property=Linger")
    linger = r.stdout.strip() == "Linger=yes"

    running = False
    if installed:
        r = _run("systemctl", "--user", "is-active", f"{_SERVICE_NAME}.service")
        running = r.stdout.strip() == "active"

    return {
        "boot_enabled": installed and enabled and linger,
        "service_installed": installed,
        "service_enabled": enabled,
        "linger_enabled": linger,
        "service_running": running,
    }


@router.get("/system/boot")
def get_boot_status():
    """Return whether the service is configured to start on boot."""
    return _boot_status()


@router.post("/system/boot")
def set_boot_status(body: dict):
    """Enable or disable start-on-boot.

    Writes the systemd unit file, enables/disables it, and manages loginctl
    linger so the service runs on boot even without a user session open.

    Body: {"enabled": true|false}
    """
    enable = bool(body.get("enabled", True))
    errors = []

    if enable:
        # Write or refresh the service unit
        work_dir = Path.cwd().resolve()
        python_exe = Path(sys.executable).resolve()
        try:
            _SERVICE_FILE.parent.mkdir(parents=True, exist_ok=True)
            _SERVICE_FILE.write_text(_service_unit(work_dir, python_exe))
            _log.info("Wrote service unit to %s", _SERVICE_FILE)
        except Exception as exc:
            errors.append(f"Could not write service file: {exc}")
            return {"ok": False, "errors": errors, **_boot_status()}

        for cmd in [
            ["systemctl", "--user", "daemon-reload"],
            ["systemctl", "--user", "enable", f"{_SERVICE_NAME}.service"],
        ]:
            r = _run(*cmd)
            if r.returncode != 0:
                errors.append(f"{' '.join(cmd)}: {r.stderr.strip() or r.stdout.strip()}")

        r = _run("loginctl", "enable-linger", os.getenv("USER", ""))
        if r.returncode != 0:
            errors.append(f"loginctl enable-linger: {r.stderr.strip()}")

    else:
        for cmd in [
            ["systemctl", "--user", "disable", f"{_SERVICE_NAME}.service"],
            ["loginctl", "disable-linger", os.getenv("USER", "")],
        ]:
            r = _run(*cmd)
            if r.returncode != 0:
                errors.append(f"{' '.join(cmd)}: {r.stderr.strip() or r.stdout.strip()}")

    status = _boot_status()
    return {"ok": not errors, "errors": errors, **status}
