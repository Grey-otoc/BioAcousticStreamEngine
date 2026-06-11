#!/usr/bin/env python3
"""Sync version from pyproject.toml → viewer/viewer.js.

Run manually:  python3 scripts/sync_version.py
Run via hook:  git config core.hooksPath .githooks   (then hooks fire on commit)
"""
import re
import sys
from pathlib import Path

ROOT   = Path(__file__).resolve().parent.parent
TOML   = ROOT / "pyproject.toml"
VIEWER = ROOT / "viewer" / "viewer.js"

def _read_version() -> str:
    m = re.search(r'^version\s*=\s*"([^"]+)"', TOML.read_text(), re.MULTILINE)
    if not m:
        sys.exit("sync_version: could not find version in pyproject.toml")
    return m.group(1)

def _patch_viewer(version: str) -> bool:
    src = VIEWER.read_text()
    new = re.sub(
        r"^(const BASE_VERSION\s*=\s*')[^']+(';)",
        rf"\g<1>{version}\g<2>",
        src,
        flags=re.MULTILINE,
    )
    if new == src:
        return False
    VIEWER.write_text(new)
    return True

if __name__ == "__main__":
    v = _read_version()
    changed = _patch_viewer(v)
    if changed:
        print(f"sync_version: viewer.js → v{v}")
    else:
        print(f"sync_version: viewer.js already at v{v}")
