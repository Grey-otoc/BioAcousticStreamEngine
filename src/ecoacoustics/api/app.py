"""
FastAPI application — serves the REST API and web UI.

IMPORTANT: The WebSocket route and all API routes must be registered BEFORE
app.mount("/", StaticFiles(...)) — StaticFiles mounted at "/" intercepts every
request including WebSocket upgrades, so anything registered after the mount
is unreachable.

Author: David Green, Blenheim Palace
"""

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
import yaml
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response
from starlette.types import Scope, Receive, Send

_log = logging.getLogger(__name__)
_AUTOSTART = Path("config/autostart.yaml")


class NoCacheStaticFiles(StaticFiles):
    """StaticFiles that tells browsers to always revalidate — prevents stale JS/CSS."""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = dict(message.get("headers", []))
                headers[b"cache-control"] = b"no-cache, must-revalidate"
                message = {**message, "headers": list(headers.items())}
            await send(message)

        await super().__call__(scope, receive, send_with_headers)

from ecoacoustics.api import state
from ecoacoustics.api.pipeline_manager import PipelineManager
from ecoacoustics.api.routes import analytics, clips, detections, devices, gallery, reports, schedule, settings, spectrogram, status
from ecoacoustics.output.heartbeat import heartbeat_loop

CONFIG_PATH = "config/settings.yaml"

# Fail fast with a clear message rather than a cryptic 500 on every request.
if not Path(CONFIG_PATH).exists():
    example = Path("config/settings.yaml.example")
    if example.exists():
        import shutil
        shutil.copy(example, CONFIG_PATH)
        _log.warning("config/settings.yaml not found — created from example. Edit it to set your site details.")
    else:
        raise FileNotFoundError(
            "config/settings.yaml not found. "
            "Run install.sh or copy config/settings.yaml.example to config/settings.yaml."
        )

_ws_clients: set[WebSocket] = set()
_broadcast_queue: asyncio.Queue = asyncio.Queue()


def get_or_create_pipeline(device_key: str, device_index=None, device_name: str = "Default",
                           config_override: dict | None = None, mic_name: str = "") -> PipelineManager:
    if device_key not in state.pipeline_instances:
        state.pipeline_instances[device_key] = PipelineManager(
            config_path=CONFIG_PATH,
            device_index=device_index,
            device_name=device_name,
            config_override=config_override,
            mic_name=mic_name,
        )
    elif config_override is not None:
        # Refresh config on the existing manager so stop+restart picks up the
        # latest device/classifier assignments from the UI without needing a
        # full server restart.
        state.pipeline_instances[device_key]._config_override = config_override
    return state.pipeline_instances[device_key]


async def _delayed_autostart(mgr, delay_secs: int = 8) -> None:
    """Resume recording after boot. Delays to let audio drivers finish initialising."""
    await asyncio.sleep(delay_secs)
    if not _AUTOSTART.exists():
        return
    try:
        with open(_AUTOSTART) as f:
            a_cfg = yaml.safe_load(f) or {}
        if not a_cfg.get("enabled", False):
            return
        with open(CONFIG_PATH) as f:
            settings = yaml.safe_load(f) or {}
        mics_with_clfs = [m for m in (settings.get("mics") or []) if m.get("classifiers")]
        if mics_with_clfs:
            from ecoacoustics.api.routes.status import start_mics
            _log.info("Autostart: resuming %d configured monitoring locations", len(mics_with_clfs))
            start_mics()
        else:
            _log.info("Autostart: resuming default schedule recording")
            mgr.start_schedule()
    except Exception as exc:
        _log.warning("Autostart failed: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    loop = asyncio.get_running_loop()
    # Store in state so sync route handlers can wire new pipelines without needing
    # asyncio.get_running_loop() (which raises RuntimeError outside async context).
    state.event_loop = loop
    state.broadcast_queue = _broadcast_queue
    mgr = get_or_create_pipeline("default", device_index=None, device_name="Default")
    mgr.set_async_context(loop, _broadcast_queue)
    task = asyncio.create_task(_broadcast_loop())
    hb_task = asyncio.create_task(heartbeat_loop(CONFIG_PATH))
    asyncio.create_task(_delayed_autostart(mgr))
    yield
    task.cancel()
    hb_task.cancel()


app = FastAPI(title="BioAcoustic Stream Engine (BASE)", lifespan=lifespan)

# ── API routes — registered first so StaticFiles mount cannot shadow them ──
app.include_router(status.router, prefix="/api")
app.include_router(analytics.router, prefix="/api")
app.include_router(schedule.router, prefix="/api")
app.include_router(detections.router, prefix="/api")
app.include_router(clips.router, prefix="/api")
app.include_router(reports.router, prefix="/api")
app.include_router(devices.router, prefix="/api")
app.include_router(settings.router, prefix="/api")
app.include_router(gallery.router, prefix="/api")
app.include_router(spectrogram.router, prefix="/api")


# ── WebSocket — must be before the StaticFiles mount ──
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    _ws_clients.add(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        _ws_clients.discard(websocket)
    except Exception:
        _ws_clients.discard(websocket)


# ── Static files — mounted last so it only catches unmatched requests ──
_web_dir    = Path(__file__).parent.parent / "web"
_viewer_dir = Path(__file__).parents[3] / "viewer"
if _viewer_dir.exists():
    app.mount("/viewer", NoCacheStaticFiles(directory=str(_viewer_dir), html=True), name="viewer")
app.mount("/", NoCacheStaticFiles(directory=str(_web_dir), html=True), name="web")


async def _broadcast_loop() -> None:
    print("[BCAST] loop started", flush=True)
    try:
        while True:
            data = await _broadcast_queue.get()
            print(f"[BCAST] got type={data.get('type')} clients={len(_ws_clients)}", flush=True)
            dead: set[WebSocket] = set()
            for ws in list(_ws_clients):
                try:
                    await ws.send_json(data)
                    print(f"[BCAST] sent ok", flush=True)
                except Exception as e:
                    print(f"[BCAST] send failed: {e}", flush=True)
                    dead.add(ws)
            _ws_clients.difference_update(dead)
    except Exception as e:
        print(f"[BCAST] loop CRASHED: {e}", flush=True)


def run(host: str = "0.0.0.0", port: int = 8000) -> None:
    uvicorn.run("ecoacoustics.api.app:app", host=host, port=port, reload=False)
