#!/usr/bin/env bash
# BioAcoustic Stream Engine (BASE) — one-shot installer
# Linux (Ubuntu 22.04+, Debian Bookworm, Raspberry Pi OS Bookworm)
#
# Usage:
#   git clone https://github.com/blenheiminnovation/BioAcousticStreamEngine.git
#   cd BioAcousticStreamEngine
#   bash install.sh
#
# What this script does:
#   1. Verifies Python 3.10+
#   2. Installs required system libraries (via apt-get)
#   3. Creates a Python virtual environment and installs all packages
#   4. Pre-clones the BuzzDetect bee classifier model
#   5. Creates output directories and seeds config files from templates
#   6. Installs and enables a systemd user service (autostart on boot)
#   7. Installs a desktop launcher

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*"; exit 1; }
step() { echo -e "\n${GREEN}▶${NC} ${BOLD}$*${NC}"; }
info() { echo -e "  $*"; }

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$INSTALL_DIR"

echo ""
echo -e "${GREEN}${BOLD}BioAcoustic Stream Engine (BASE) — Installer${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── 0. Python version ─────────────────────────────────────────────────────────
step "Checking Python version"
if ! command -v python3 &>/dev/null; then
  err "python3 not found. Install Python 3.10 or later first."
fi
PY_VER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PY_MAJOR=$(python3 -c 'import sys; print(sys.version_info.major)')
PY_MINOR=$(python3 -c 'import sys; print(sys.version_info.minor)')
if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
  err "Python 3.10+ required (found $PY_VER). Upgrade Python and retry."
fi
ok "Python $PY_VER"

# ── 1. System libraries ───────────────────────────────────────────────────────
step "Installing system libraries"

PKGS=()
_need_pkg() { dpkg -l "$1" &>/dev/null || PKGS+=("$1"); }
_need_cmd()  { command -v "$1" &>/dev/null || PKGS+=("$2"); }

_need_pkg libportaudio2
_need_pkg portaudio19-dev
_need_pkg libsndfile1       # soundfile / librosa
_need_pkg libgomp1          # OpenMP for PyTorch / numpy
_need_cmd pactl  pipewire-pulse       # audio device listing in web UI
_need_cmd parec  pulseaudio-utils     # per-source audio capture (multi-mic)
_need_cmd git    git                  # BuzzDetect clone + model downloads

if [ "${#PKGS[@]}" -gt 0 ]; then
  warn "Installing system packages (requires sudo): ${PKGS[*]}"
  sudo apt-get update -qq
  sudo apt-get install -y "${PKGS[@]}"
fi
ok "All system libraries present"

# ── 2. Python virtual environment ─────────────────────────────────────────────
step "Setting up Python environment"

if [ ! -d ".venv" ]; then
  python3 -m venv .venv
  ok ".venv created"
else
  ok ".venv already exists — updating"
fi

info "Installing Python packages (may take several minutes on first run)…"
.venv/bin/pip install --upgrade pip -q
.venv/bin/pip install -e "." -q
ok "Python packages installed"

# ── 3. BuzzDetect bee model ───────────────────────────────────────────────────
step "Setting up BuzzDetect bee model"

BUZZ_DIR="external/buzzdetect"
if [ ! -d "$BUZZ_DIR" ]; then
  mkdir -p external
  git clone --depth 1 --branch v1.0.1 \
    https://github.com/OSU-Bee-Lab/buzzdetect.git "$BUZZ_DIR" -q
  ok "BuzzDetect cloned"
else
  ok "BuzzDetect already present"
fi

# ── 4. Output directories ─────────────────────────────────────────────────────
step "Creating output directories"
mkdir -p output/clips
ok "output/ ready"

# ── 5. Configuration files ────────────────────────────────────────────────────
step "Seeding configuration files"

if [ ! -f "config/settings.yaml" ]; then
  cp config/settings.yaml.example config/settings.yaml
  ok "Created config/settings.yaml — edit to set your site location and active classifiers"
else
  ok "config/settings.yaml exists"
fi

if [ ! -f "config/secrets.yaml" ]; then
  cp config/secrets.yaml.example config/secrets.yaml
  ok "Created config/secrets.yaml — add MQTT credentials here (never committed to git)"
else
  ok "config/secrets.yaml exists"
fi

# ── 6. Systemd service (autostart on boot) ────────────────────────────────────
step "Installing systemd service"

SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/bioacoustic-stream-engine.service"
mkdir -p "$SERVICE_DIR"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=BioAcoustic Stream Engine — web UI
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/.venv/bin/python -m ecoacoustics.main web --no-browser
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable bioacoustic-stream-engine
ok "Systemd service installed and enabled"

# Enable linger so the service survives logout and starts at boot
if loginctl enable-linger "$USER" 2>/dev/null; then
  ok "Boot autostart enabled (loginctl linger)"
else
  warn "Could not enable linger — BASE will start on login but not at unattended boot"
fi

# ── 7. Desktop launcher ───────────────────────────────────────────────────────
step "Installing desktop launcher"

DESKTOP_DIR="$HOME/.local/share/applications"
mkdir -p "$DESKTOP_DIR"

ICON=""
[ -f "$INSTALL_DIR/viewer/assets/base-logo.png" ] && ICON="$INSTALL_DIR/viewer/assets/base-logo.png"

cat > "$DESKTOP_DIR/bioacoustic-stream-engine.desktop" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=BioAcoustic Stream Engine (BASE)
Comment=Real-time acoustic biodiversity monitoring — Blenheim Palace Innovation
Exec=$INSTALL_DIR/start_web.sh
Icon=$ICON
Terminal=false
Categories=Science;Education;
StartupNotify=true
EOF

# Also update the repo's .desktop file so it works for the current user
sed -i "s|^Exec=.*|Exec=$INSTALL_DIR/start_web.sh|" \
  "$INSTALL_DIR/bioacoustic-stream-engine.desktop" 2>/dev/null || true

ok "Desktop launcher installed"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  BASE installed successfully!${NC}"
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  The web UI will start automatically on boot and after login."
echo ""
echo "  Start now:    systemctl --user start bioacoustic-stream-engine"
echo "  Open:         http://localhost:8000"
echo "  Viewer:       http://localhost:8000/viewer/"
echo ""
echo "  First-time setup:"
echo "    1. Open the dashboard and go to Settings"
echo "    2. Set your recording location (name, lat/lon)"
echo "    3. Assign microphones to classifiers under Schedule → Classifiers"
echo "    4. Configure MQTT in Settings if publishing to a broker"
echo ""
echo "  config/settings.yaml — all configuration (safe to commit)"
echo "  config/secrets.yaml  — MQTT credentials (gitignored, never committed)"
echo ""
echo "  List microphones:  .venv/bin/python -m ecoacoustics.main list-devices"
echo ""
