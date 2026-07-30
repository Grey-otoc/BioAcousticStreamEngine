"""Software auto-update route — pull latest code from GitHub and restart.

On restart the systemd service (Restart=always) brings the server back up
automatically, and _delayed_autostart() restores any in-progress recordings
from autostart.yaml — no manual intervention needed.

Defaults: enabled=True, auto_apply=True, check every hour.
All defaults can be overridden via settings.yaml under the 'updates' key.

Author: David Green, Blenheim Palace
"""

import asyncio
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml
from fastapi import APIRouter
from fastapi.params import Body

router = APIRouter()
_log = logging.getLogger(__name__)

_SETTINGS = Path("config/settings.yaml")
_REPO_DIR = Path(__file__).resolve().parents[4]  # project root

_state: dict = {
    "last_check": None,        # ISO timestamp string
    "current_sha": None,
    "remote_sha": None,
    "update_available": False,
    "checking": False,
    "applying": False,
    "last_error": None,
}


def _load_cfg() -> dict:
    try:
        if _SETTINGS.exists():
            with open(_SETTINGS) as f:
                return (yaml.safe_load(f) or {}).get("updates", {})
    except Exception:
        pass
    return {}


async def _git(*args) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        "git", *args,
        cwd=str(_REPO_DIR),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
    return proc.returncode, stdout.decode().strip(), stderr.decode().strip()


async def check_for_update() -> bool:
    """Fetch from origin and return True if the remote is ahead of HEAD."""
    _state["checking"] = True
    _state["last_error"] = None
    try:
        rc, _, err = await _git("fetch", "origin")
        if rc != 0:
            _state["last_error"] = f"git fetch: {err or 'failed'}"
            return False

        rc, local_sha, _ = await _git("rev-parse", "HEAD")
        if rc != 0:
            return False

        # Try origin/HEAD first; fall back to origin/<current branch>
        rc, remote_sha, _ = await _git("rev-parse", "origin/HEAD")
        if rc != 0:
            _, branch, _ = await _git("rev-parse", "--abbrev-ref", "HEAD")
            rc, remote_sha, _ = await _git("rev-parse", f"origin/{branch.strip()}")

        _state["current_sha"] = local_sha
        _state["remote_sha"] = remote_sha
        _state["last_check"] = datetime.now(timezone.utc).isoformat()

        # Count commits remote has that local doesn't — >0 means we can pull.
        # (local_sha != remote_sha also catches the case where local is ahead,
        # which git pull would reject; this distinguishes that correctly.)
        rc2, ahead_count, _ = await _git(
            "rev-list", "--count", f"HEAD..{remote_sha}"
        )
        _state["update_available"] = bool(rc == 0 and rc2 == 0 and int(ahead_count or 0) > 0)
        return _state["update_available"]
    except Exception as exc:
        _state["last_error"] = str(exc)
        return False
    finally:
        _state["checking"] = False


async def apply_update() -> bool:
    """Pull latest code, reinstall the package, then restart the service."""
    _state["applying"] = True
    _state["last_error"] = None
    try:
        rc, out, err = await _git("pull", "--ff-only")
        if rc != 0:
            _state["last_error"] = f"git pull: {err or 'failed'} — push may have unresolved conflicts with local changes"
            return False
        _log.info("Auto-update: git pull OK — %s", out.splitlines()[-1] if out else "up-to-date")

        # Reinstall so importlib.metadata.version() returns the new version number
        pip = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "pip", "install", "-e", ".", "--quiet",
            cwd=str(_REPO_DIR),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, pip_err = await asyncio.wait_for(pip.communicate(), timeout=120)
            if pip.returncode != 0:
                _state["last_error"] = f"pip install: {pip_err.decode().strip()}"
                return False
        except asyncio.TimeoutError:
            pip.kill()
            _state["last_error"] = "pip install timed out"
            return False

        _log.info("Auto-update: pip install OK — restarting service")

        # Restart via systemd if available (Restart=always brings it back up;
        # _delayed_autostart() then restores active recordings from autostart.yaml).
        # Fall back to os.execv for development environments without systemd.
        service = "bioacoustic-stream-engine.service"
        ctl = await asyncio.create_subprocess_exec(
            "systemctl", "--user", "is-active", "--quiet", service,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await ctl.wait()
        if ctl.returncode == 0:
            restart = await asyncio.create_subprocess_exec(
                "systemctl", "--user", "restart", service,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(restart.wait(), timeout=15)
            # We won't reach here — systemd killed this process. That's correct.
        else:
            # Not managed by systemd — replace the process in place.
            os.execv(sys.executable, [sys.executable] + sys.argv)

        return True  # unreachable after restart, but satisfies type-checker
    except Exception as exc:
        _state["last_error"] = str(exc)
        return False
    finally:
        _state["applying"] = False


async def update_checker_loop() -> None:
    """Background task: periodically check for and optionally apply updates."""
    await asyncio.sleep(30)  # let the server settle after startup
    while True:
        cfg = _load_cfg()
        if cfg.get("enabled", True):
            try:
                available = await check_for_update()
                if available and cfg.get("auto_apply", True):
                    _log.info("Auto-update: new commits available — applying")
                    await apply_update()
            except Exception as exc:
                _log.warning("Auto-update check failed: %s", exc)

        interval_hours = float(cfg.get("check_interval_hours", 0.25))
        await asyncio.sleep(max(0.25, interval_hours) * 3600)


@router.get("/updates/status")
def get_update_status():
    cfg = _load_cfg()
    return {
        "enabled":              cfg.get("enabled", True),
        "auto_apply":           cfg.get("auto_apply", True),
        "check_interval_hours": cfg.get("check_interval_hours", 0.25),
        **_state,
    }


@router.post("/updates/check")
async def trigger_check():
    if _state["checking"]:
        return {"status": "already_checking", **_state}
    available = await check_for_update()
    return {"update_available": available, **_state}


@router.post("/updates/apply")
async def trigger_apply():
    if _state["applying"]:
        return {"status": "already_applying"}
    asyncio.create_task(apply_update())
    return {"status": "applying"}


@router.post("/updates/settings")
def save_update_settings(body: dict = Body(...)):
    try:
        with open(_SETTINGS) as f:
            cfg = yaml.safe_load(f) or {}
        cfg.setdefault("updates", {})
        if "enabled" in body:
            cfg["updates"]["enabled"] = bool(body["enabled"])
        if "auto_apply" in body:
            cfg["updates"]["auto_apply"] = bool(body["auto_apply"])
        if "check_interval_hours" in body:
            cfg["updates"]["check_interval_hours"] = float(body["check_interval_hours"])
        with open(_SETTINGS, "w") as f:
            yaml.dump(cfg, f, default_flow_style=False, allow_unicode=True)
        return {"saved": True}
    except Exception as exc:
        return {"saved": False, "error": str(exc)}
