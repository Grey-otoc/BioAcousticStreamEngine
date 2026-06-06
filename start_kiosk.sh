#!/usr/bin/env bash
# Launch BASE in browser kiosk mode (full-screen, no chrome/UI).
# The BASE server is started separately by systemd — this script just
# waits for it to be ready and then opens the browser.

set -euo pipefail

URL="http://localhost:8000"
TIMEOUT=60   # seconds to wait for BASE before giving up

# Prefer Chrome/Chromium; fall back to Firefox
if   command -v google-chrome      &>/dev/null; then BROWSER="google-chrome"
elif command -v chromium-browser   &>/dev/null; then BROWSER="chromium-browser"
elif command -v chromium           &>/dev/null; then BROWSER="chromium"
elif command -v firefox            &>/dev/null; then BROWSER="firefox"
else
  echo "No supported browser found (google-chrome, chromium-browser, or firefox)."
  exit 1
fi

# Wait for BASE to respond
echo "Waiting for BASE at $URL…"
for i in $(seq 1 $TIMEOUT); do
  if curl -sf --max-time 2 "$URL" >/dev/null 2>&1; then
    echo "BASE ready — launching $BROWSER in kiosk mode"
    break
  fi
  if [ "$i" -eq "$TIMEOUT" ]; then
    echo "BASE did not start within ${TIMEOUT}s. Check: systemctl --user status bioacoustic-stream-engine"
    exit 1
  fi
  sleep 1
done

if [ "$BROWSER" = "firefox" ]; then
  exec "$BROWSER" --kiosk "$URL"
else
  exec "$BROWSER" \
    --kiosk \
    --no-first-run \
    --disable-restore-session-state \
    --disable-infobars \
    --noerrdialogs \
    --disable-features=TranslateUI \
    --user-data-dir=/tmp/base-kiosk \
    "$URL"
fi
