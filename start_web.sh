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

# If an existing BASE process is already on port 8000, stop it gracefully
# before starting so we never hit "address already in use".
if lsof -ti tcp:8000 >/dev/null 2>&1; then
  echo "Stopping existing BASE process on port 8000…"
  pkill -f "ecoacoustics.main web" 2>/dev/null || true
  sleep 1
fi

.venv/bin/python -m ecoacoustics.main web "$@"
