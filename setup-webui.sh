#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$PROJECT_ROOT/logs"
RUN_LOG="$LOG_DIR/setup-webui.log"
SETUP_LOG_REL="logs/setup.log"

mkdir -p "$LOG_DIR"

ts_now() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts_now)] [setup-webui] $*" | tee -a "$RUN_LOG"; }
warn() { echo "[$(ts_now)] [setup-webui] WARN: $*" | tee -a "$RUN_LOG" >&2; }
err() { echo "[$(ts_now)] [setup-webui] ERROR: $*" | tee -a "$RUN_LOG" >&2; }

usage() {
  cat <<USAGE
Usage: ./setup-webui.sh [options]

Options:
  --runtime auto|docker|apple-container   Container runtime (default: auto)
  --with-service                          Run setup service step (default: on)
  --no-service                            Skip service registration/start
  --skip-verify                           Skip final verify step
  --mount-empty                           Write empty mount allowlist (default)
  --mount-json-file <file>                Mount allowlist JSON file to apply
  --mount-json '<json>'                   Mount allowlist JSON string to apply
  --yes                                   Non-interactive mode (auto choices)
  --help                                  Show this help

Examples:
  ./setup-webui.sh
  ./setup-webui.sh --runtime docker
  ./setup-webui.sh --no-service
  ./setup-webui.sh --mount-json-file ./config-examples/mount-allowlist.json
USAGE
}

RUNTIME="auto"
WITH_SERVICE="true"
SKIP_VERIFY="false"
NON_INTERACTIVE="false"
MOUNT_MODE="empty"
MOUNT_JSON=""
MOUNT_JSON_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --runtime)
      RUNTIME="${2:-}"
      shift 2
      ;;
    --with-service)
      WITH_SERVICE="true"
      shift
      ;;
    --no-service)
      WITH_SERVICE="false"
      shift
      ;;
    --skip-verify)
      SKIP_VERIFY="true"
      shift
      ;;
    --mount-empty)
      MOUNT_MODE="empty"
      shift
      ;;
    --mount-json-file)
      MOUNT_MODE="json-file"
      MOUNT_JSON_FILE="${2:-}"
      shift 2
      ;;
    --mount-json)
      MOUNT_MODE="json"
      MOUNT_JSON="${2:-}"
      shift 2
      ;;
    --yes)
      NON_INTERACTIVE="true"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      err "Unknown argument: $1"
      usage
      exit 2
      ;;
  esac
done

if [[ "$RUNTIME" != "auto" && "$RUNTIME" != "docker" && "$RUNTIME" != "apple-container" ]]; then
  err "Invalid --runtime value: $RUNTIME"
  exit 2
fi

if [[ "$MOUNT_MODE" == "json-file" && -z "$MOUNT_JSON_FILE" ]]; then
  err "--mount-json-file requires a file path"
  exit 2
fi
if [[ "$MOUNT_MODE" == "json" && -z "$MOUNT_JSON" ]]; then
  err "--mount-json requires a JSON string"
  exit 2
fi
if [[ "$MOUNT_MODE" == "json-file" && ! -f "$MOUNT_JSON_FILE" ]]; then
  err "Mount JSON file not found: $MOUNT_JSON_FILE"
  exit 2
fi

on_error() {
  local exit_code=$?
  local line_no=${1:-unknown}
  err "Failed at line $line_no (exit=$exit_code)."
  err "Run logs: $RUN_LOG"
  err "Step logs: $PROJECT_ROOT/$SETUP_LOG_REL"
  exit "$exit_code"
}
trap 'on_error $LINENO' ERR

cd "$PROJECT_ROOT"

run_cmd() {
  log "Running: $*"
  "$@" 2>&1 | tee -a "$RUN_LOG"
}

run_setup_step() {
  local step="$1"
  shift || true

  local output_file
  output_file="$(mktemp)"
  local status_line

  log "Step start: $step"
  if ! npx tsx setup/index.ts --step "$step" -- "$@" >"$output_file" 2>&1; then
    cat "$output_file" | tee -a "$RUN_LOG"
    rm -f "$output_file"
    err "Setup step '$step' command failed"
    return 1
  fi

  cat "$output_file" | tee -a "$RUN_LOG"

  status_line="$(awk -F': ' '/^STATUS: /{print $2}' "$output_file" | tail -1 || true)"
  rm -f "$output_file"

  if [[ "$status_line" != "success" ]]; then
    err "Setup step '$step' reported STATUS=$status_line"
    return 1
  fi

  log "Step success: $step"
}

docker_running() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

apple_container_available() {
  command -v container >/dev/null 2>&1
}

start_docker_best_effort() {
  if docker_running; then
    return 0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    return 1
  fi

  local uname_s
  uname_s="$(uname -s)"

  if [[ "$uname_s" == "Darwin" ]]; then
    warn "Docker installed but not running, attempting to start Docker Desktop"
    open -a Docker >/dev/null 2>&1 || true
  elif [[ "$uname_s" == "Linux" ]]; then
    if command -v systemctl >/dev/null 2>&1; then
      warn "Docker installed but not running, attempting 'sudo systemctl start docker'"
      sudo systemctl start docker >/dev/null 2>&1 || true
    fi
  fi

  for _ in {1..20}; do
    if docker_running; then
      return 0
    fi
    sleep 2
  done

  return 1
}

choose_runtime() {
  if [[ "$RUNTIME" == "docker" ]]; then
    if ! start_docker_best_effort; then
      err "Docker runtime requested but not available/running"
      return 1
    fi
    echo "docker"
    return 0
  fi

  if [[ "$RUNTIME" == "apple-container" ]]; then
    if ! apple_container_available; then
      err "Apple Container runtime requested but 'container' CLI not found"
      return 1
    fi
    echo "apple-container"
    return 0
  fi

  if start_docker_best_effort; then
    echo "docker"
    return 0
  fi

  if apple_container_available; then
    echo "apple-container"
    return 0
  fi

  err "No supported runtime is ready. Install/start Docker, or install Apple Container."
  return 1
}

confirm_or_exit() {
  local prompt="$1"
  if [[ "$NON_INTERACTIVE" == "true" ]]; then
    log "Non-interactive: auto-yes -> $prompt"
    return 0
  fi

  read -r -p "$prompt [y/N]: " answer
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) err "Cancelled by user"; exit 1 ;;
  esac
}

log "=== WebUI setup started ==="
log "Project root: $PROJECT_ROOT"
log "Run log: $RUN_LOG"

confirm_or_exit "Proceed with WebUI setup now?"

# 1) Bootstrap dependencies
run_cmd bash setup.sh

# 2) Environment step
run_setup_step environment

# 3) Runtime selection + container build
SELECTED_RUNTIME="$(choose_runtime)"
log "Selected runtime: $SELECTED_RUNTIME"
run_setup_step container --runtime "$SELECTED_RUNTIME"

# 4) Mount allowlist
case "$MOUNT_MODE" in
  empty)
    run_setup_step mounts --empty
    ;;
  json-file)
    run_setup_step mounts --json "$(cat "$MOUNT_JSON_FILE")"
    ;;
  json)
    run_setup_step mounts --json "$MOUNT_JSON"
    ;;
esac

# 5) WebUI build validation
run_setup_step webui

# 6) Optional service
WEBUI_SERVICE_NAME="easyteamclaw-webui"

if [[ "$WITH_SERVICE" == "true" ]]; then
  run_setup_step service --target webui --service-name "$WEBUI_SERVICE_NAME"
else
  log "Skipping service step (use --with-service or remove --no-service)"
fi

# 7) Verify
if [[ "$SKIP_VERIFY" == "true" ]]; then
  log "Skipping verify step"
else
  run_setup_step verify --mode webui --service-name "$WEBUI_SERVICE_NAME"
fi

log "=== WebUI setup completed successfully ==="
CONTROL_HINT=""
case "$(uname -s)" in
  Darwin)
    CONTROL_HINT="launchctl kickstart -k gui/\\$(id -u)/com.${WEBUI_SERVICE_NAME}"
    ;;
  Linux)
    CONTROL_HINT="systemctl --user restart ${WEBUI_SERVICE_NAME}"
    ;;
esac

cat <<DONE

Setup complete.

Next:
1. Open: http://localhost:3000
2. Add provider URL/API key, refresh model list, then chat.
3. If you disabled service setup, start manually: npm run web

Logs:
- $RUN_LOG
- $PROJECT_ROOT/$SETUP_LOG_REL

Service:
- Name: ${WEBUI_SERVICE_NAME}
${CONTROL_HINT:+- Restart command: ${CONTROL_HINT}}

DONE
