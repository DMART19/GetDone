#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$ROOT/agent"
DIST_DIR="$ROOT/dist"

mkdir -p "$DIST_DIR"

AGENT_VERSION="${GETDONE_AGENT_VERSION:-0.2.0-development}"
GIT_COMMIT="${GETDONE_GIT_COMMIT:-$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || printf unknown)}"
BUILD_TIME="${GETDONE_BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
LDFLAGS="-s -w -X github.com/DMART19/GetDone/agent/internal/version.AgentVersion=$AGENT_VERSION -X github.com/DMART19/GetDone/agent/internal/version.GitCommit=$GIT_COMMIT -X github.com/DMART19/GetDone/agent/internal/version.BuildTime=$BUILD_TIME"

(
  cd "$AGENT_DIR"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$LDFLAGS" -o "$DIST_DIR/getdone-agent-linux-amd64" ./cmd/getdone-agent
  CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "$LDFLAGS" -o "$DIST_DIR/getdone-agent-linux-arm64" ./cmd/getdone-agent
)

test -s "$DIST_DIR/getdone-agent-linux-amd64"
test -s "$DIST_DIR/getdone-agent-linux-arm64"

printf 'Built %s\n' "$DIST_DIR/getdone-agent-linux-amd64"
printf 'Built %s\n' "$DIST_DIR/getdone-agent-linux-arm64"
