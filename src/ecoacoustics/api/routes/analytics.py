"""API routes — advanced analytics dashboard."""

import csv
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

import yaml
from fastapi import APIRouter, Query

router = APIRouter()
_SETTINGS = Path("config/settings.yaml")


def _cfg():
    if not _SETTINGS.exists():
        return {}
    with open(_SETTINGS) as f:
        return yaml.safe_load(f) or {}


def _paths():
    out = _cfg().get("output", {})
    return (
        Path(out.get("detections_csv", "output/detections.csv")),
        Path(out.get("sessions_csv", "output/sessions.csv")),
    )


def _iter_detections(det_path, date_from, date_to, locations, classifiers, taxa, confidence):
    if not det_path.exists():
        return
    with open(det_path) as f:
        for row in csv.DictReader(f):
            d = row.get("date", "")
            if d < date_from or d > date_to:
                continue
            loc = row.get("monitoring_location", "") or row.get("location_name", "")
            if locations and loc not in locations:
                continue
            clf = row.get("classifier", "")
            if classifiers and clf not in classifiers:
                continue
            if taxa and row.get("species_common", "") not in taxa:
                continue
            try:
                conf = float(row.get("confidence", 0) or 0)
            except ValueError:
                conf = 0.0
            if conf < confidence:
                continue
            yield row


@router.get("/analytics/stats")
def analytics_stats(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    locations: Optional[str] = Query(None, description="Comma-separated location names"),
    classifiers: Optional[str] = Query(None),
    taxa: Optional[str] = Query(None),
    confidence: float = Query(0.0),
):
    """Aggregate stats: detections, species, sessions, unique dates."""
    det_path, _ = _paths()
    today = date.today().strftime("%Y-%m-%d")
    df = date_from or (date.today() - timedelta(days=30)).strftime("%Y-%m-%d")
    dt = date_to or today
    loc_set = set(x.strip() for x in locations.split(",") if x.strip()) if locations else set()
    clf_set = set(x.strip() for x in classifiers.split(",") if x.strip()) if classifiers else set()
    taxa_set = set(x.strip() for x in taxa.split(",") if x.strip()) if taxa else set()

    total = 0
    species_seen: set[str] = set()
    sessions_seen: set[str] = set()
    dates_seen: set[str] = set()

    for row in _iter_detections(det_path, df, dt, loc_set, clf_set, taxa_set, confidence):
        total += 1
        species_seen.add(row.get("species_common", ""))
        sessions_seen.add(row.get("session_id", ""))
        dates_seen.add(row.get("date", ""))

    return {
        "date_from": df,
        "date_to": dt,
        "total_detections": total,
        "species_count": len(species_seen),
        "session_count": len(sessions_seen),
        "active_days": len(dates_seen),
    }


@router.get("/analytics/activity")
def analytics_activity(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    locations: Optional[str] = Query(None),
    classifiers: Optional[str] = Query(None),
    taxa: Optional[str] = Query(None),
    confidence: float = Query(0.0),
):
    """Daily detection counts, broken down by classifier, for time-series charts.

    Also returns the same data for the preceding equal-length period so the
    frontend can compute period-over-period trends.
    """
    det_path, _ = _paths()
    today = date.today().strftime("%Y-%m-%d")
    df = date_from or (date.today() - timedelta(days=30)).strftime("%Y-%m-%d")
    dt = date_to or today
    loc_set = set(x.strip() for x in locations.split(",") if x.strip()) if locations else set()
    clf_set = set(x.strip() for x in classifiers.split(",") if x.strip()) if classifiers else set()
    taxa_set = set(x.strip() for x in taxa.split(",") if x.strip()) if taxa else set()

    # Previous period of equal length for trend comparison
    d0 = date.fromisoformat(df)
    d1 = date.fromisoformat(dt)
    delta = (d1 - d0).days + 1
    prev_from = (d0 - timedelta(days=delta)).strftime("%Y-%m-%d")
    prev_to   = (d0 - timedelta(days=1)).strftime("%Y-%m-%d")

    # day → classifier → count
    current: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    prev:    dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    classifiers_seen: set[str] = set()

    for row in _iter_detections(det_path, prev_from, dt, loc_set, clf_set, taxa_set, confidence):
        d = row.get("date", "")
        clf = row.get("classifier", "") or "unknown"
        classifiers_seen.add(clf)
        if df <= d <= dt:
            current[d][clf] += 1
        elif prev_from <= d <= prev_to:
            prev[d][clf] += 1

    # Build a contiguous date list for the current period
    dates = [(d0 + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(delta)]

    return {
        "date_from": df,
        "date_to": dt,
        "classifiers": sorted(classifiers_seen),
        "dates": dates,
        "current": {d: dict(current.get(d, {})) for d in dates},
        "prev_from": prev_from,
        "prev_to": prev_to,
        "previous": {d: dict(prev.get(d, {})) for d in dates},
    }


@router.get("/analytics/species")
def analytics_species(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    locations: Optional[str] = Query(None),
    classifiers: Optional[str] = Query(None),
    confidence: float = Query(0.0),
):
    """Per-species detection counts plus comparison to the previous equal period."""
    det_path, _ = _paths()
    today = date.today().strftime("%Y-%m-%d")
    df = date_from or (date.today() - timedelta(days=30)).strftime("%Y-%m-%d")
    dt = date_to or today
    loc_set = set(x.strip() for x in locations.split(",") if x.strip()) if locations else set()
    clf_set = set(x.strip() for x in classifiers.split(",") if x.strip()) if classifiers else set()

    d0 = date.fromisoformat(df)
    d1 = date.fromisoformat(dt)
    delta = (d1 - d0).days + 1
    prev_from = (d0 - timedelta(days=delta)).strftime("%Y-%m-%d")
    prev_to   = (d0 - timedelta(days=1)).strftime("%Y-%m-%d")

    # species → {count, prev_count, conf_sum, conf_n, classifier, last_seen}
    data: dict[str, dict] = defaultdict(lambda: {
        "count": 0, "prev_count": 0, "conf_sum": 0.0, "conf_n": 0,
        "classifier": "", "last_seen": "",
    })

    for row in _iter_detections(det_path, prev_from, dt, loc_set, clf_set, set(), confidence):
        sp = row.get("species_common", "").strip()
        if not sp:
            continue
        d = row.get("date", "")
        conf = float(row.get("confidence", 0) or 0)
        r = data[sp]
        if df <= d <= dt:
            r["count"] += 1
            r["conf_sum"] += conf
            r["conf_n"] += 1
            if d > r["last_seen"]:
                r["last_seen"] = d
                r["classifier"] = row.get("classifier", "")
        elif prev_from <= d <= prev_to:
            r["prev_count"] += 1

    results = []
    for sp, r in sorted(data.items(), key=lambda x: -x[1]["count"]):
        avg_conf = r["conf_sum"] / r["conf_n"] if r["conf_n"] else 0.0
        prev = r["prev_count"]
        cur  = r["count"]
        trend = ((cur - prev) / prev * 100) if prev else (100.0 if cur else 0.0)
        results.append({
            "species": sp,
            "count": cur,
            "prev_count": prev,
            "trend_pct": round(trend, 1),
            "avg_confidence": round(avg_conf, 3),
            "classifier": r["classifier"],
            "last_seen": r["last_seen"],
        })

    return {"species": results, "date_from": df, "date_to": dt}


@router.get("/analytics/locations")
def analytics_locations(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    confidence: float = Query(0.0),
):
    """Configured monitoring locations with lat/lon and detection counts."""
    cfg = _cfg()
    det_path, _ = _paths()
    today = date.today().strftime("%Y-%m-%d")
    df = date_from or (date.today() - timedelta(days=30)).strftime("%Y-%m-%d")
    dt = date_to or today

    # Count detections per location name
    counts: dict[str, int] = defaultdict(int)
    if det_path.exists():
        with open(det_path) as f:
            for row in csv.DictReader(f):
                d = row.get("date", "")
                if d < df or d > dt:
                    continue
                try:
                    if float(row.get("confidence", 0) or 0) < confidence:
                        continue
                except ValueError:
                    pass
                loc = row.get("monitoring_location", "") or row.get("location_name", "")
                if loc:
                    counts[loc] += 1

    mics = cfg.get("mics") or []
    results = []
    for mic in mics:
        name = (mic.get("name") or "").strip()
        if not name:
            continue
        results.append({
            "name": name,
            "latitude": mic.get("latitude"),
            "longitude": mic.get("longitude"),
            "classifiers": mic.get("classifiers") or [],
            "detections": counts.get(name, 0),
            "has_device": bool(mic.get("device")),
        })

    # Site-level fallback lat/lon
    site = cfg.get("location", {})
    return {
        "locations": results,
        "site": {
            "name": site.get("name", "Blenheim Palace"),
            "latitude": site.get("latitude"),
            "longitude": site.get("longitude"),
        },
    }
