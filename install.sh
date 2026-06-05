#!/usr/bin/env bash
# BioAcoustic Stream Engine (BASE) — one-shot installer
# Linux (Ubuntu 22.04+, Debian Bookworm, Raspberry Pi OS Bookworm)
#
# Usage:
#   git clone https://github.com/blenheiminnovation/BioAcousticStreamEngine.git
#   cd BioAcousticStreamEngine
#   bash install.sh
#   bash install.sh --no-service        # skip autostart setup
#   bash install.sh --python python3.11 # use a specific interpreter
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

INSTALL_SYSTEM_PACKAGES=1
INSTALL_SERVICE=1
INSTALL_DESKTOP=1
PYTHON_CMD=""

usage() {
cat <<'EOF'
Usage: bash install.sh [options]

Options:
  --python CMD          Python interpreter to use (e.g. python3.12)
  --no-system-packages  Skip apt package installation
  --no-service          Skip systemd user service/autostart setup
  --no-desktop          Skip desktop launcher setup
  -h, --help            Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --python)
      [ "$#" -ge 2 ] || err "--python requires a command"
      PYTHON_CMD="$2"
      shift 2
      ;;
    --no-system-packages)
      INSTALL_SYSTEM_PACKAGES=0
      shift
      ;;
    --no-service)
      INSTALL_SERVICE=0
      shift
      ;;
    --no-desktop)
      INSTALL_DESKTOP=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "Unknown option: $1"
      ;;
  esac
done

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$INSTALL_DIR"

echo ""
echo -e "${GREEN}${BOLD}BioAcoustic Stream Engine (BASE) — Installer${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

python_version() {
  "$1" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'
}

python_is_supported() {
  command -v "$1" &>/dev/null || return 1
  "$1" -c 'import sys; raise SystemExit(0 if (3, 10) <= sys.version_info[:2] <= (3, 12) else 1)'
}

python_file_is_supported() {
  [ -x "$1" ] || return 1
  "$1" -c 'import sys; raise SystemExit(0 if (3, 10) <= sys.version_info[:2] <= (3, 12) else 1)'
}

ensure_uv() {
  if command -v uv &>/dev/null; then
    UV_CMD="uv"
    return 0
  fi

  UV_CMD="$INSTALL_DIR/.tools/uv"
  if [ -x "$UV_CMD" ]; then
    return 0
  fi

  mkdir -p "$INSTALL_DIR/.tools"
  info "Installing uv locally so the installer can fetch Python 3.12..."

  if command -v curl &>/dev/null; then
    curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR="$INSTALL_DIR/.tools" sh
  elif command -v wget &>/dev/null; then
    wget -qO- https://astral.sh/uv/install.sh | UV_INSTALL_DIR="$INSTALL_DIR/.tools" sh
  else
    return 1
  fi

  [ -x "$UV_CMD" ]
}

# ── 0. Python version ─────────────────────────────────────────────────────────
step "Checking Python version"

if [ -n "$PYTHON_CMD" ]; then
  python_is_supported "$PYTHON_CMD" || err "$PYTHON_CMD must be Python 3.10, 3.11, or 3.12"
elif command -v uv &>/dev/null || [ -x "$INSTALL_DIR/.tools/uv" ]; then
  UV_CMD="$(command -v uv || true)"
  [ -n "$UV_CMD" ] || UV_CMD="$INSTALL_DIR/.tools/uv"
elif python_is_supported python3.12; then
  PYTHON_CMD="python3.12"
elif python_is_supported python3.11; then
  PYTHON_CMD="python3.11"
elif python_is_supported python3.10; then
  PYTHON_CMD="python3.10"
elif python_is_supported python3; then
  PYTHON_CMD="python3"
else
  if command -v python3 &>/dev/null; then
    FOUND_PY=$(python_version python3)
    warn "Default python3 is $FOUND_PY. BASE dependencies are safest on Python 3.10-3.12."
  else
    warn "No suitable python3 command found."
  fi

  if ensure_uv; then
    ok "uv available for project-local Python 3.12 install"
  else
    err "Install Python 3.12, 3.11, or 3.10, then rerun: bash install.sh --python python3.12"
  fi
fi

if [ -n "${PYTHON_CMD:-}" ]; then
  PY_VER=$(python_version "$PYTHON_CMD")
  ok "$PYTHON_CMD ($PY_VER)"
else
  ok "Using uv-managed Python 3.12"
fi

# ── 1. System libraries ───────────────────────────────────────────────────────
step "Installing system libraries"

PKGS=()
_need_pkg() {
  if command -v dpkg &>/dev/null; then
    dpkg -l "$1" &>/dev/null || PKGS+=("$1")
  fi
}
_need_cmd() { command -v "$1" &>/dev/null || PKGS+=("$2"); }

_need_pkg libportaudio2
_need_pkg portaudio19-dev
_need_pkg libsndfile1       # soundfile / librosa
_need_pkg libgomp1          # OpenMP for PyTorch / numpy
_need_cmd pactl  pipewire-pulse       # audio device listing in web UI
_need_cmd parec  pulseaudio-utils     # per-source audio capture (multi-mic)
_need_cmd git    git                  # BuzzDetect clone + model downloads

if [ "$INSTALL_SYSTEM_PACKAGES" -eq 0 ]; then
  warn "Skipping system package installation"
elif ! command -v apt-get &>/dev/null; then
  warn "apt-get not found. Install these packages manually if audio dependencies fail: ${PKGS[*]:-none}"
elif [ "${#PKGS[@]}" -gt 0 ]; then
  warn "Installing system packages (requires sudo): ${PKGS[*]}"
  sudo apt-get update -qq
  sudo apt-get install -y "${PKGS[@]}"
  ok "System packages installed"
else
  ok "All system libraries present"
fi

# ── 2. Python virtual environment ─────────────────────────────────────────────
step "Setting up Python environment"

if [ -d ".venv" ] && [ ! -x ".venv/bin/python" ]; then
  BROKEN_VENV=".venv.broken.$(date +%Y%m%d%H%M%S)"
  warn ".venv exists but is incomplete; moving it to $BROKEN_VENV"
  mv .venv "$BROKEN_VENV"
fi

if [ -x ".venv/bin/python" ] && ! python_file_is_supported ".venv/bin/python"; then
  VENV_PY=$(.venv/bin/python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  BROKEN_VENV=".venv.unsupported-python-$VENV_PY.$(date +%Y%m%d%H%M%S)"
  warn ".venv uses Python $VENV_PY; moving it to $BROKEN_VENV"
  mv .venv "$BROKEN_VENV"
fi

if [ ! -d ".venv" ]; then
  if [ -n "${PYTHON_CMD:-}" ]; then
    "$PYTHON_CMD" -m venv .venv
  else
    "$UV_CMD" venv --python 3.12 .venv
  fi
  ok ".venv created"
else
  ok ".venv already exists — updating"
fi

if [ ! -x ".venv/bin/pip" ]; then
  if .venv/bin/python -m ensurepip --upgrade &>/dev/null; then
    ok "pip bootstrapped into .venv"
  else
    BROKEN_VENV=".venv.broken.$(date +%Y%m%d%H%M%S)"
    warn ".venv has no pip and ensurepip failed; moving it to $BROKEN_VENV"
    mv .venv "$BROKEN_VENV"
    if [ -n "${PYTHON_CMD:-}" ]; then
      "$PYTHON_CMD" -m venv .venv
    else
      "$UV_CMD" venv --python 3.12 .venv
    fi
  fi
fi

info "Installing Python packages (may take several minutes on first run)…"
if [ -n "${UV_CMD:-}" ] && { command -v "$UV_CMD" &>/dev/null || [ -x "$UV_CMD" ]; }; then
  "$UV_CMD" pip install --python .venv/bin/python -e "."
else
  .venv/bin/python -m pip install --upgrade pip -q
  .venv/bin/python -m pip install -e "." -q
fi
ok "Python packages installed"

# ── 3. BuzzDetect bee model ───────────────────────────────────────────────────
step "Setting up BuzzDetect bee model"

BUZZ_DIR="external/buzzdetect"
if [ ! -d "$BUZZ_DIR" ]; then
  mkdir -p external
  if git clone --depth 1 --branch v1.0.1 \
      https://github.com/OSU-Bee-Lab/buzzdetect.git "$BUZZ_DIR" -q; then
    ok "BuzzDetect cloned"
  else
    warn "BuzzDetect clone failed; BASE can still run, but bee detection may download later or be disabled"
  fi
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

if [ "$INSTALL_SERVICE" -eq 1 ]; then
  # ── 6. Systemd service (autostart on boot) ─────────────────────────────────
  step "Installing systemd service"

  if ! command -v systemctl &>/dev/null; then
    warn "systemctl not found; skipping autostart service"
  else
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

    SERVICE_NAME="bioacoustic-stream-engine.service"
    if systemctl --user daemon-reload \
    && systemctl --user enable "$SERVICE_FILE" \
    && systemctl --user daemon-reload \
    && systemctl --user restart "$SERVICE_NAME"; then
      ok "Systemd service installed, enabled, and started"
    else
      warn "Could not enable systemd user service; start manually with bash start_web.sh"
    fi

    # Enable linger so the service survives logout and starts at boot
    if command -v loginctl &>/dev/null && loginctl enable-linger "$USER" 2>/dev/null; then
      ok "Boot autostart enabled (loginctl linger)"
    else
      warn "Could not enable linger — BASE will start on login but not at unattended boot"
    fi
  fi
else
  warn "Skipping systemd service"
fi

if [ "$INSTALL_DESKTOP" -eq 1 ]; then
  # ── 7. Desktop launcher ────────────────────────────────────────────────────
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
else
  warn "Skipping desktop launcher"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  BASE installed successfully!${NC}"
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
if [ "$INSTALL_SERVICE" -eq 1 ]; then
  echo "  The web UI is started now and will restart automatically on boot and after login."
  echo ""
  echo "  Check status:  systemctl --user status bioacoustic-stream-engine"
else
  echo "  Autostart was skipped."
  echo ""
  echo "  Start now:     bash start_web.sh"
fi
echo ""
echo "  Open:          http://localhost:8000"
echo "  Viewer:        http://localhost:8000/viewer/"
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
echo "  Troubleshooting:"
echo "    bash install.sh --python python3.12   # force a specific Python"
echo "    bash install.sh --no-service          # skip autostart if systemd fails"
echo "    bash install.sh --no-system-packages  # skip apt (needs manual deps)"
echo ""
