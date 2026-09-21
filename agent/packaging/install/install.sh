#!/usr/bin/env bash
set -euo pipefail

ENROLLMENT_TOKEN=""
CONTROL_PLANE_URL="${GETDONE_CONTROL_PLANE_URL:-}"
DOWNLOAD_BASE="${GETDONE_AGENT_DOWNLOAD_BASE_URL:-}"
INSTALL_ROOT="/usr/local/bin"
CONFIG_DIR="/etc/getdone-agent"
STATE_DIR="/var/lib/getdone-agent"
LOG_DIR="/var/log/getdone-agent"

usage() {
  cat <<'USAGE'
Usage:
  install.sh --enrollment <token> --control-plane <https://host> --download-base <https://host/releases/current>

Required:
  --enrollment      One-time GetDone Node enrollment token
  --control-plane   GetDone control-plane base URL
  --download-base   Base URL containing manifest.json, binary, and .sha256 files
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --enrollment)
      ENROLLMENT_TOKEN="${2:-}"
      shift 2
      ;;
    --control-plane)
      CONTROL_PLANE_URL="${2:-}"
      shift 2
      ;;
    --download-base)
      DOWNLOAD_BASE="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$ENROLLMENT_TOKEN" || -z "$CONTROL_PLANE_URL" || -z "$DOWNLOAD_BASE" ]]; then
  usage >&2
  exit 2
fi

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "GetDone Node Agent installation requires root." >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64|amd64)
    ARCH="amd64"
    ;;
  aarch64|arm64)
    ARCH="arm64"
    ;;
  *)
    echo "Unsupported Linux architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

ARTIFACT="getdone-agent-linux-${ARCH}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"; unset ENROLLMENT_TOKEN' EXIT

curl --fail --silent --show-error --location   "$DOWNLOAD_BASE/manifest.json"   --output "$TMP_DIR/manifest.json"

if ! grep -Fq "\"artifact\":\"$ARTIFACT\"" "$TMP_DIR/manifest.json"   && ! grep -Fq "\"artifact\": \"$ARTIFACT\"" "$TMP_DIR/manifest.json"; then
  echo "Release manifest does not authorize artifact $ARTIFACT" >&2
  exit 1
fi

curl --fail --silent --show-error --location   "$DOWNLOAD_BASE/$ARTIFACT"   --output "$TMP_DIR/$ARTIFACT"
curl --fail --silent --show-error --location   "$DOWNLOAD_BASE/$ARTIFACT.sha256"   --output "$TMP_DIR/$ARTIFACT.sha256"

(
  cd "$TMP_DIR"
  sha256sum --check "$ARTIFACT.sha256"
)

if ! id getdone-agent >/dev/null 2>&1; then
  useradd --system --home "$STATE_DIR" --shell /usr/sbin/nologin getdone-agent
fi

install -d -m 0750 -o getdone-agent -g getdone-agent "$STATE_DIR" "$LOG_DIR"
install -d -m 0750 -o root -g getdone-agent "$CONFIG_DIR"
install -m 0755 "$TMP_DIR/$ARTIFACT" "$INSTALL_ROOT/getdone-agent"
install -m 0644   "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/systemd/getdone-agent.service"   /etc/systemd/system/getdone-agent.service

umask 077
cat > "$CONFIG_DIR/config.json" <<EOF
{
  "controlPlaneUrl": "$CONTROL_PLANE_URL",
  "stateDir": "$STATE_DIR",
  "logLevel": "info",
  "enrollmentToken": "$ENROLLMENT_TOKEN",
  "protocolVersion": "1.0.0"
}
EOF
chown root:getdone-agent "$CONFIG_DIR/config.json"
chmod 0600 "$CONFIG_DIR/config.json"

systemctl daemon-reload
systemctl enable --now getdone-agent.service

unset ENROLLMENT_TOKEN
echo "GetDone Node Agent installed and enrollment started."
