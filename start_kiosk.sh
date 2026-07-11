#!/usr/bin/env bash
# Launch BASE in browser kiosk mode (full-screen, no chrome/UI).
# The BASE server is started separately by systemd — this script just
# waits for it to be ready and then opens the browser.
#
# Log: /tmp/base-kiosk.log — check this if kiosk doesn't appear after boot.

LOG="/tmp/base-kiosk.log"
exec >> "$LOG" 2>&1
echo "--- $(date) ---"

URL="http://localhost:8000"
TIMEOUT=90   # seconds to wait for BASE before giving up

# Give the desktop environment time to fully initialise before trying to open
# a window — without this, the browser can fail silently on early autostart.
echo "Startup delay (10s)…"
sleep 10

# Extend PATH to cover common browser install locations not always in env
export PATH="/usr/bin:/usr/local/bin:/snap/bin:$PATH"

# Prefer Chrome/Chromium; fall back to Firefox
BROWSER=""
for b in google-chrome chromium-browser chromium firefox; do
  if command -v "$b" &>/dev/null; then
    BROWSER="$b"
    break
  fi
done

if [ -z "$BROWSER" ]; then
  echo "ERROR: No supported browser found (google-chrome, chromium-browser, chromium, firefox)."
  echo "Install one with: sudo apt install chromium-browser"
  exit 1
fi
echo "Browser: $BROWSER"

# Wait for BASE to respond
echo "Waiting for BASE at $URL…"
for i in $(seq 1 $TIMEOUT); do
  if curl -sf --max-time 2 "$URL" >/dev/null 2>&1; then
    echo "BASE ready after ${i}s — launching $BROWSER in kiosk mode"
    break
  fi
  if [ "$i" -eq "$TIMEOUT" ]; then
    echo "ERROR: BASE did not start within ${TIMEOUT}s."
    echo "Check: systemctl --user status bioacoustic-stream-engine"
    echo "Check: journalctl --user -u bioacoustic-stream-engine -n 50"
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
