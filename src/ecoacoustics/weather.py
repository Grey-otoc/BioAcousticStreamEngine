"""
Open-Meteo weather cache — fetches current conditions every hour.

Uses the Open-Meteo free API (no key required).  The most recent
observation is stored in memory and stamped onto every detection so
both the CSV log and the MQTT payload include ambient conditions at
the time of each call.

Settings block (config/settings.yaml):
  weather:
    enabled: true       # set false to disable entirely

Author: David Green, Blenheim Palace
"""

import json
import logging
import threading
import urllib.request

_log = logging.getLogger(__name__)

_URL = (
    "https://api.open-meteo.com/v1/forecast"
    "?latitude={lat}&longitude={lon}"
    "&current=temperature_2m,relative_humidity_2m,"
    "wind_speed_10m,wind_direction_10m,"
    "weather_code,cloud_cover,precipitation"
    "&wind_speed_unit=kmh&timezone=auto"
)

FETCH_INTERVAL = 900  # seconds between refreshes (Open-Meteo current updates every ~15 min)


class WeatherCache:
    """Thread-safe hourly weather cache backed by the Open-Meteo free API.

    Call get() from any thread to receive the most recent observation as a
    plain dict.  Returns an empty dict if the first fetch hasn't succeeded yet
    or if weather is disabled — callers should handle both cases gracefully.
    """

    def __init__(self, lat: float, lon: float, enabled: bool = True):
        self._lat = lat
        self._lon = lon
        self._enabled = enabled
        self._data: dict = {}
        self._lock = threading.Lock()
        self._timer: threading.Timer | None = None

        if enabled:
            self._fetch()
            self._schedule_next()

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------

    def get(self) -> dict:
        """Return the latest cached weather snapshot (empty dict if unavailable)."""
        with self._lock:
            return dict(self._data)

    def stop(self) -> None:
        """Cancel the scheduled background refresh."""
        if self._timer:
            self._timer.cancel()
            self._timer = None

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _fetch(self) -> None:
        try:
            url = _URL.format(lat=self._lat, lon=self._lon)
            with urllib.request.urlopen(url, timeout=10) as resp:
                raw = json.loads(resp.read())
            cur = raw.get("current", {})
            with self._lock:
                self._data = {
                    "temperature_c":     cur.get("temperature_2m"),
                    "humidity_pct":      cur.get("relative_humidity_2m"),
                    "wind_speed_kmh":    cur.get("wind_speed_10m"),
                    "wind_direction_deg": cur.get("wind_direction_10m"),
                    "weather_code":      cur.get("weather_code"),
                    "cloud_cover_pct":   cur.get("cloud_cover"),
                    "precipitation_mm":  cur.get("precipitation"),
                }
            _log.info(
                "Weather: %.1f°C  humidity %d%%  wind %.1f km/h",
                self._data.get("temperature_c") or 0,
                self._data.get("humidity_pct") or 0,
                self._data.get("wind_speed_kmh") or 0,
            )
        except Exception as exc:
            _log.warning("Weather fetch failed: %s", exc)

    def _schedule_next(self) -> None:
        self._timer = threading.Timer(FETCH_INTERVAL, self._refresh)
        self._timer.daemon = True
        self._timer.start()

    def _refresh(self) -> None:
        self._fetch()
        self._schedule_next()
