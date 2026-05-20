#!/bin/bash
# TermuxAgent Service Setup
# Installs TermuxAgent as a persistent background service using runit.
# Also configures Termux:Boot for auto-start on device reboot.
#
# Requirements:
#   - Termux v0.118+ (F-Droid or GitHub release recommended)
#   - Termux:Boot (F-Droid) for auto-start on boot
#
# Usage:
#   bash setup-termux-service.sh [--bin /path/to/termux-agent]

set -euo pipefail

# ── colors ────────────────────────────────────────────────────────────────────
RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m' BLUE='\033[0;34m' NC='\033[0m'
ok()   { echo -e "${GREEN}  ✓ ${*}${NC}"; }
warn() { echo -e "${YELLOW}  ⚠ ${*}${NC}"; }
fail() { echo -e "${RED}  ✖ ${*}${NC}"; exit 1; }
info() { echo -e "${BLUE}${*}${NC}"; }

# ── paths ─────────────────────────────────────────────────────────────────────
PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
SERVICE_DIR="${PREFIX}/var/service/termux-agent"
BOOT_DIR="${HOME}/.termux/boot"
LOG_DIR="${HOME}/.termux-agent/logs"
AGENT_BIN="${1:-${PREFIX}/bin/termux-agent}"

# Allow --bin flag
if [[ "${1:-}" == "--bin" ]]; then
  AGENT_BIN="${2:?Usage: $0 --bin /path/to/termux-agent}"
fi

# ── header ────────────────────────────────────────────────────────────────────
echo
info "╔══════════════════════════════════════════════╗"
info "║   TermuxAgent Service Setup                  ║"
info "║   Persistent daemon + boot auto-start        ║"
info "╚══════════════════════════════════════════════╝"
echo

# ── guard: must be in Termux ──────────────────────────────────────────────────
if [[ -z "${TERMUX_VERSION:-}" && -z "${TERMUX_API_VERSION:-}" ]]; then
  warn "TERMUX_VERSION not set — are you running inside Termux?"
  read -r -p "Continue anyway? (y/N) " reply
  [[ "${reply}" =~ ^[Yy]$ ]] || exit 1
fi

# ── 1. install required packages ──────────────────────────────────────────────
info "1/4  Installing required packages…"

pkg_install() {
  if ! command -v "$1" &>/dev/null; then
    echo "     Installing $2…"
    pkg install -y "$2" || warn "Could not install $2 — some features may be unavailable"
  else
    ok "$1 already installed"
  fi
}

pkg update -y -q
pkg_install sv          termux-services   # runit service supervisor
pkg_install termux-api  termux-api        # Android device integration

# Verify sv (runit) installed
if ! command -v sv &>/dev/null; then
  fail "sv (runit) not found after install. Try: pkg install termux-services"
fi

ok "Packages ready"

# ── 2. create runit service ───────────────────────────────────────────────────
info "2/4  Creating runit service…"

mkdir -p "${SERVICE_DIR}/log" "${LOG_DIR}"

# run script — runit calls this to start/restart the agent
cat > "${SERVICE_DIR}/run" << EOF
#!/${PREFIX}/bin/sh
exec 2>&1
exec ${AGENT_BIN} daemon-worker
EOF
chmod 755 "${SERVICE_DIR}/run"

# log run script — pipes stdout to svlogd for rotation
cat > "${SERVICE_DIR}/log/run" << EOF
#!/${PREFIX}/bin/sh
exec svlogd -tt ${LOG_DIR}
EOF
chmod 755 "${SERVICE_DIR}/log/run"

# Remove 'down' file so runit starts the service automatically
rm -f "${SERVICE_DIR}/down"

ok "Service installed → ${SERVICE_DIR}"
ok "Logs directory    → ${LOG_DIR}"

# ── 3. configure Termux:Boot auto-start ──────────────────────────────────────
info "3/4  Configuring boot auto-start…"

mkdir -p "${BOOT_DIR}"

cat > "${BOOT_DIR}/termux-agent.sh" << EOF
#!/${PREFIX}/bin/sh
# TermuxAgent auto-start on boot
# Requires: Termux:Boot app installed from F-Droid

# Wait for system to settle
sleep 8

# Acquire wake lock so Android doesn't kill the process
termux-wake-lock

# Start via runit if available, otherwise start directly
if command -v sv >/dev/null 2>&1; then
  sv start termux-agent
else
  ${AGENT_BIN} daemon start &
fi
EOF
chmod 755 "${BOOT_DIR}/termux-agent.sh"

ok "Boot script → ${BOOT_DIR}/termux-agent.sh"

# ── 4. set up notification channel ───────────────────────────────────────────
info "4/4  Creating persistent status notification…"

if command -v termux-notification &>/dev/null; then
  termux-notification \
    --id "termux-agent-daemon" \
    --title "● TermuxAgent" \
    --content "Service installed — run 'sv start termux-agent' to start" \
    --priority low \
    --ongoing 2>/dev/null || warn "Could not create notification (Termux:API may need setup)"
  ok "Notification created"
else
  warn "termux-api not found — install Termux:API from F-Droid for notification support"
fi

# ── done ──────────────────────────────────────────────────────────────────────
echo
info "╔══════════════════════════════════════════════╗"
info "║   Setup complete!                            ║"
info "╚══════════════════════════════════════════════╝"
echo
echo "  Start service now:"
echo "    sv start termux-agent"
echo ""
echo "  Or via agent CLI:"
echo "    termux-agent daemon start"
echo ""
echo "  Check status:"
echo "    termux-agent daemon status"
echo "    sv status termux-agent"
echo ""
echo "  View logs:"
echo "    tail -f ${LOG_DIR}/current"
echo ""
echo "  Boot auto-start:"
echo "    Install Termux:Boot from F-Droid — scripts in ${BOOT_DIR}/"
echo "    run automatically on every device reboot."
echo ""
warn "On Android 10+: tap the Termux notification to bring the terminal"
warn "to the foreground the FIRST time after a reboot (Android restriction)."
echo
