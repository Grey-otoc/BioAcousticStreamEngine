"""API routes — system status and pipeline control."""

import re
import shutil
from datetime import datetime
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

import yaml
from fastapi import APIRouter, HTTPException

_AUTOSTART = Path("config/autostart.yaml")


def _load_autostart() -> dict:
    try:
        if _AUTOSTART.exists():
            with open(_AUTOSTART) as f:
                return yaml.safe_load(f) or {}
    except Exception:
        pass
    return {}


def _save_autostart(enabled: bool) -> None:
    try:
        data = _load_autostart()
        data["enabled"] = enabled
        if not enabled:
            data["active_mics"] = []
        with open(_AUTOSTART, "w") as f:
            yaml.dump(data, f)
    except Exception:
        pass


def _track_mic_active(mic_name: str, active: bool) -> None:
    """Add or remove a mic from the persisted active_mics list.

    This lets autostart on reboot restore exactly which locations were
    running — stopping one mic doesn't disable the others.
    """
    try:
        data = _load_autostart()
        mics = [m for m in (data.get("active_mics") or []) if m != mic_name]
        if active:
            mics.append(mic_name)
        data["active_mics"] = mics
        data["enabled"] = bool(mics)
        with open(_AUTOSTART, "w") as f:
            yaml.dump(data, f)
    except Exception:
        pass

from ecoacoustics.api import state

router = APIRouter()

try:
    _VERSION = version("ecoacoustics")
except PackageNotFoundError:
    # Keep in sync with pyproject.toml [project] version
    _VERSION = "1.1.0"


def _ensure_pipeline(device_key: str, device_index=None, device_name: str = "Default",
                     config_override: dict | None = None, mic_name: str = ""):
    """Return an existing pipeline manager, creating and wiring one if needed."""
    from ecoacoustics.api.app import get_or_create_pipeline

    mgr = get_or_create_pipeline(device_key, device_index, device_name,
                                 config_override=config_override, mic_name=mic_name)
    if mgr._broadcast_queue is None and state.event_loop is not None:
        mgr.set_async_context(state.event_loop, state.broadcast_queue)
    return mgr


@router.get("/status")
def get_status():
    cfg_path = Path("config/settings.yaml")
    with open(cfg_path) as f:
        cfg = yaml.safe_load(f)

    disk = shutil.disk_usage(".")

    from ecoacoustics.scheduler import Scheduler
    scheduler = Scheduler.from_config(cfg)
    windows = [
        {"name": n, "start": s.strftime("%H:%M"), "end": e.strftime("%H:%M")}
        for s, e, n in scheduler.window_times()
    ]
    current = scheduler.current_window()

    pipelines = {k: v.status_dict() for k, v in state.pipeline_instances.items()}
    any_running = any(p["state"] != "idle" for p in pipelines.values())

    return {
        "version": _VERSION,
        "timestamp": datetime.now().isoformat(),
        "pipeline": pipelines.get("default", {"state": "idle"}),
        "pipelines": pipelines,
        "any_running": any_running,
        "schedule": {
            "windows": windows,
            "active_window": current[2] if current else None,
            "next_window": scheduler.next_window()[2] if scheduler.next_window() else None,
            "seconds_until_next": round(scheduler.seconds_until_next()),
        },
        "disk_free_gb": round(shutil.disk_usage(".").free / (1024 ** 3), 1),
        "mqtt_enabled": cfg.get("mqtt", {}).get("enabled", False),
    }


@router.post("/pipeline/wake")
def start_wake(duration_minutes: int = None, device_key: str = "default",
               device_index: int = None, device_name: str = "Default"):
    mgr = _ensure_pipeline(device_key, device_index, device_name)
    ok = mgr.start_wake(duration_minutes=duration_minutes)
    if not ok:
        raise HTTPException(400, f"Device '{device_key}' is already running")
    _save_autostart(True)
    return {"started": True, "mode": "wake", "device_key": device_key}


@router.post("/pipeline/schedule")
def start_schedule(device_key: str = "default", device_index: int = None, device_name: str = "Default"):
    mgr = _ensure_pipeline(device_key, device_index, device_name)
    ok = mgr.start_schedule()
    if not ok:
        raise HTTPException(400, f"Device '{device_key}' is already running")
    _save_autostart(True)
    return {"started": True, "mode": "schedule", "device_key": device_key}


@router.post("/pipeline/stop")
def stop_pipeline(device_key: str = "default"):
    if device_key not in state.pipeline_instances:
        raise HTTPException(404, f"No pipeline found for '{device_key}'")
    mgr = state.pipeline_instances[device_key]
    ok = mgr.stop()
    if not ok:
        raise HTTPException(400, f"Device '{device_key}' is not running")
    if mgr._mic_name:
        _track_mic_active(mgr._mic_name, False)
    else:
        _save_autostart(False)
    return {"stopped": True, "device_key": device_key}


@router.post("/debug/test_broadcast")
async def test_broadcast():
    """Fire a fake detection into the WebSocket broadcast to test the delivery chain."""
    from ecoacoustics.api.app import _broadcast_queue, _ws_clients
    payload = {
        "type": "detection",
        "session_id": "test",
        "window_name": "test",
        "date": "2026-05-01",
        "time": "12:00:00",
        "classifier": "bird",
        "species_common": "TEST — Robin",
        "species_scientific": "Erithacus rubecula",
        "confidence": 0.99,
        "call_number_in_session": 1,
        "device_name": "Test",
        "device_index": None,
    }
    await _broadcast_queue.put(payload)
    return {"queued": True, "ws_clients": len(_ws_clients)}


@router.post("/pipeline/stop_all")
def stop_all():
    stopped = []
    for key, mgr in state.pipeline_instances.items():
        if mgr.state != "idle":
            mgr.stop()
            stopped.append(key)
    _save_autostart(False)
    return {"stopped": stopped}


def _mic_key(name: str) -> str:
    return "mic_" + re.sub(r"[^a-z0-9]+", "_", (name or "").lower()).strip("_")


@router.post("/pipeline/start_mics")
def start_mics(name: str = "", only: list[str] | None = None):
    """Start one pipeline per configured monitoring location that has classifiers assigned.

    Pass name= to start a single location by name; omit to start all configured locations.
    Pass only= (list of names) to restrict which locations are started — used by autostart
    on reboot to restore exactly the locations that were running before shutdown.
    Each location's own schedule field (auto | manual) determines whether it runs
    against the schedule windows or starts in immediate listen-now (wake) mode.
    """
    with open(Path("config/settings.yaml")) as f:
        cfg = yaml.safe_load(f)

    mics = cfg.get("mics") or []
    started, already_running, skipped = [], [], []

    for mic in mics:
        mic_name = mic.get("name", "")

        if name and mic_name != name:
            continue
        if only is not None and mic_name not in only:
            continue

        clf_list = mic.get("classifiers") or []
        device = mic.get("device") or None

        if not clf_list:
            skipped.append(mic_name or "?")
            continue

        key = _mic_key(mic_name)
        config_override = {
            "classifiers": {
                "active": clf_list,
                "devices": {clf: device for clf in clf_list},
            },
            "mics": [mic],
        }

        mgr = _ensure_pipeline(key, device_index=None, device_name=mic_name,
                               config_override=config_override, mic_name=mic_name)

        # Respect per-location schedule setting: manual → wake now, auto → follow schedule
        mic_mode = mic.get("schedule", "auto")
        ok = mgr.start_wake() if mic_mode == "manual" else mgr.start_schedule()
        (started if ok else already_running).append(mic_name)
        if ok:
            _track_mic_active(mic_name, True)

    return {"started": started, "already_running": already_running, "skipped": skipped}
