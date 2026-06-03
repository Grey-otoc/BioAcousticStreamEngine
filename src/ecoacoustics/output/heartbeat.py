"""
Periodic MQTT heartbeat — confirms the BASE process is alive.

Publishes a retained JSON message to {prefix}/status on startup and
every hour regardless of whether any classifier pipeline is running.
Retained=True means a subscriber that connects later will immediately
see the most recent heartbeat without waiting up to an hour.

Topic:  {prefix}/status
Payload example:
  {
    "type":           "heartbeat",
    "timestamp":      "2026-06-03T10:00:00",
    "site_name":      "Charlbury",
    "site_latitude":  51.8403,
    "site_longitude": -1.3625
  }

Author: David Green, Blenheim Palace
"""

import asyncio
import datetime
import json
import logging
import re
import ssl
from pathlib import Path

import yaml

_log = logging.getLogger(__name__)

HEARTBEAT_INTERVAL = 3600  # seconds


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (name or "base").lower()).strip("_") or "base"


def _publish_once(cfg: dict, secrets: dict) -> None:
    """Synchronous: connect, publish retained heartbeat, disconnect."""
    import paho.mqtt.client as mqtt

    mqtt_cfg = cfg.get("mqtt", {})
    if not mqtt_cfg.get("enabled", False):
        return

    host     = mqtt_cfg.get("host", "localhost")
    port     = mqtt_cfg.get("port", 1883)
    tls      = mqtt_cfg.get("tls", False)
    prefix   = mqtt_cfg.get("topic_prefix", "bioacoustics").rstrip("/")
    username = secrets.get("mqtt", {}).get("username")
    password = secrets.get("mqtt", {}).get("password")

    loc = cfg.get("location", {})
    payload = json.dumps({
        "type":          "heartbeat",
        "timestamp":     datetime.datetime.now().isoformat(timespec="seconds"),
        "site_name":     loc.get("name", ""),
        "site_latitude": loc.get("latitude"),
        "site_longitude": loc.get("longitude"),
    })

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    if tls:
        client.tls_set(cert_reqs=ssl.CERT_REQUIRED)
    if username:
        client.username_pw_set(username, password)

    site_slug = _slug(loc.get("name", "base"))
    client.connect(host, port, keepalive=10)
    client.publish(f"{prefix}/status/{site_slug}", payload, retain=True)
    client.disconnect()
    _log.info("Heartbeat → %s/status/%s", prefix, site_slug)


def _load(config_path: str) -> tuple[dict, dict]:
    with open(config_path) as f:
        cfg = yaml.safe_load(f)
    secrets_path = Path(config_path).parent / "secrets.yaml"
    secrets: dict = {}
    if secrets_path.exists():
        with open(secrets_path) as f:
            secrets = yaml.safe_load(f) or {}
    return cfg, secrets


async def heartbeat_loop(config_path: str = "config/settings.yaml") -> None:
    """Async task: publish heartbeat immediately then every HEARTBEAT_INTERVAL seconds."""
    while True:
        try:
            cfg, secrets = await asyncio.to_thread(_load, config_path)
            await asyncio.to_thread(_publish_once, cfg, secrets)
        except Exception as exc:
            _log.warning("Heartbeat failed: %s", exc)
        await asyncio.sleep(HEARTBEAT_INTERVAL)
