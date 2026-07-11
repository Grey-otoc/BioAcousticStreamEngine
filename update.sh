#!/usr/bin/env bash
# BioAcoustic Stream Engine (BASE) — update script
#
# Run this after every git pull to update Python packages and restart the
# service.  Checks that auto-start-on-boot is configured and prompts to
# fix it if not.
#
# Usage:
#   bash update.sh          # interactive (prompts if auto-start is not set up)
#   bash update.sh --quiet  # non-interactive, no prompts

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*"; exit 1; }
step() { echo -e "\n${GREEN}▶${NC} ${BOLD}$*${NC}"; }
info() { echo -e "  $*"; }

QUIET=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --quiet) QUIET=1; shift ;;
    -h|--help)
      echo "Usage: bash update.sh [--quiet]"
      exit 0
      ;;
    *) err "Unknown option: $1" ;;
  esac
done

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$INSTALL_DIR"

echo ""
echo -e "${GREEN}${BOLD}BioAcoustic Stream Engine (BASE) — Updater${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── 1. Pull latest code ───────────────────────────────────────────────────────
step "Pulling latest code"
git pull
ok "Code up to date"

# ── 2. Update Python packages ─────────────────────────────────────────────────
step "Updating Python packages"
if [ ! -x ".venv/bin/python" ]; then
  err "No .venv found — run 'bash install.sh' first to set up the environment."
fi

if command -v uv &>/dev/null || [ -x ".tools/uv" ]; then
  UV_CMD="$(command -v uv 2>/dev/null || echo "$INSTALL_DIR/.tools/uv")"
  "$UV_CMD" pip install --python .venv/bin/python -e "." -q
else
  .venv/bin/python -m pip install -e "." -q
fi
ok "Python packages updated"

# ── 3. Restart service if running ────────────────────────────────────────────
step "Restarting BASE service"
SERVICE_NAME="bioacoustic-stream-engine.service"
if command -v systemctl &>/dev/null && systemctl --user is-active "$SERVICE_NAME" &>/dev/null; then
  systemctl --user restart "$SERVICE_NAME"
  ok "Service restarted"
else
  ok "Service not currently running — start with: bash start_web.sh"
fi

# ── 4. Check auto-start configuration ────────────────────────────────────────
step "Checking auto-start configuration"

SERVICE_FILE="$HOME/.config/systemd/user/bioacoustic-stream-engine.service"
LINGER_OK=0
RESUME_OK=0
SERVICE_OK=0

[ -f "$SERVICE_FILE" ] && SERVICE_OK=1

if command -v loginctl &>/dev/null; then
  loginctl show-user "$USER" --property=Linger 2>/dev/null | grep -q "Linger=yes" && LINGER_OK=1
fi

AUTOSTART_FILE="$INSTALL_DIR/config/autostart.yaml"
[ -f "$AUTOSTART_FILE" ] && grep -q "enabled: true" "$AUTOSTART_FILE" && RESUME_OK=1

ALL_OK=$(( SERVICE_OK && LINGER_OK && RESUME_OK ))

if [ "$ALL_OK" -eq 1 ]; then
  ok "Auto-start fully configured — BASE will record automatically after reboot"
else
  echo ""
  warn "Auto-start on boot is not fully configured:"
  [ "$SERVICE_OK" -eq 0 ] && warn "  • Systemd service not installed"
  [ "$LINGER_OK"  -eq 0 ] && warn "  • loginctl linger not enabled (service won't start at unattended boot)"
  [ "$RESUME_OK"  -eq 0 ] && warn "  • Recording won't resume after reboot (config/autostart.yaml disabled)"
  echo ""
  if [ "$QUIET" -eq 0 ] && [ -t 0 ]; then
    read -r -p "  Fix auto-start now? [Y/n] " _ans
    if [[ "${_ans,,}" != "n" ]]; then
      bash "$INSTALL_DIR/install.sh" --no-system-packages --no-desktop --auto-resume
    fi
  else
    info "Run 'bash install.sh --auto-resume' to configure auto-start."
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  BASE updated successfully!${NC}"
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Open:  http://localhost:8000"
echo ""
