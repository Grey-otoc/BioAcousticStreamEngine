#!/bin/bash
# Launch the Bioacoustic Stream Engine web UI.
# Run from the project root directory.

cd "$(dirname "$0")"

# On a fresh install or after git pull, settings.yaml may not exist
# (it is gitignored so it is never committed). Copy the example if needed.
if [ ! -f "config/settings.yaml" ]; then
  if [ -f "config/settings.yaml.example" ]; then
    cp config/settings.yaml.example config/settings.yaml
    echo "Created config/settings.yaml from example — edit to set your site details."
  else
    echo "ERROR: config/settings.yaml not found and no example to copy."
    echo "Run install.sh first, or copy config/settings.yaml.example to config/settings.yaml manually."
    exit 1
  fi
fi

# Same for secrets.yaml (MQTT credentials).
if [ ! -f "config/secrets.yaml" ]; then
  [ -f "config/secrets.yaml.example" ] && cp config/secrets.yaml.example config/secrets.yaml
fi

# Stop any existing BASE process before starting so we never hit "address already in use".
# The systemd service (installed by install.sh) must be stopped first — pkill alone won't
# work because systemd immediately restarts the process after it is killed.
if systemctl --user is-active bioacoustic-stream-engine.service >/dev/null 2>&1; then
  echo "Stopping BASE systemd service…"
  systemctl --user stop bioacoustic-stream-engine.service
  sleep 1
fi
# Also catch any orphaned process not managed by systemd (e.g. a previous manual start).
if lsof -ti tcp:8000 >/dev/null 2>&1; then
  echo "Stopping existing process on port 8000…"
  pkill -f "ecoacoustics.main web" 2>/dev/null || true
  sleep 1
fi

.venv/bin/python -m ecoacoustics.main web "$@"
