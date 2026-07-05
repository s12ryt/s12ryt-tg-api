#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/s12ryt/s12ryt-tg-api.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
DEFAULT_APP_DIR="/opt/s12ryt-tg-api"
APP_DIR="${APP_DIR:-$DEFAULT_APP_DIR}"
DOCKER_APP_DIR="${DOCKER_APP_DIR:-/opt/s12ryt-tg-api-docker}"
SERVICE_NAME="${SERVICE_NAME:-s12ryt-tg-api}"
SERVICE_USER="${SERVICE_USER:-s12ryt}"
SERVICE_GROUP="${SERVICE_GROUP:-s12ryt}"
NODE_VERSION="${NODE_VERSION:-22.17.1}"
DOCKER_IMAGE="${DOCKER_IMAGE:-ghcr.io/s12ryt/s12ryt-tg-api:latest}"
DOCKER_CONTAINER="${DOCKER_CONTAINER:-s12ryt-tg-api}"

RUNNER=""
PACKAGE_MANAGER=""
NODE_BIN_DIR=""
ACTION=""
DEPLOY_MODE=""
ENV_MODE=""
API_PORT_VALUE="${API_PORT:-8000}"
ORIGINAL_UID="$(id -u)"
ORIGINAL_GID="$(id -g)"

log() { printf '[vps] %s\n' "$*"; }
warn() { printf '[vps][warn] %s\n' "$*" >&2; }
die() { printf '[vps][error] %s\n' "$*" >&2; exit 1; }

has_cmd() { command -v "$1" >/dev/null 2>&1; }

read_input() {
  local prompt="$1"
  local __var="$2"
  local secret="${3:-false}"

  if [ -r /dev/tty ]; then
    printf '%s' "$prompt" >/dev/tty
    if [ "$secret" = "true" ]; then
      IFS= read -r -s "$__var" </dev/tty
      printf '\n' >/dev/tty
    else
      IFS= read -r "$__var" </dev/tty
    fi
    return 0
  fi

  if [ "$secret" = "true" ]; then
    read -r -s -p "$prompt" "$__var"
    printf '\n' >&2
  else
    read -r -p "$prompt" "$__var"
  fi
}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif has_cmd sudo; then
    sudo "$@"
  else
    die "This step requires root privileges. Re-run as root or install sudo."
  fi
}

prompt_default() {
  local prompt="$1"
  local default="$2"
  local value=""
  read_input "$prompt [$default]: " value
  printf '%s' "${value:-$default}"
}

prompt_secret() {
  local prompt="$1"
  local value=""
  read_input "$prompt: " value true
  printf '%s' "$value"
}

confirm_default_yes() {
  local prompt="$1"
  local answer=""
  read_input "$prompt [Y/n]: " answer
  case "$answer" in
    ""|y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

choose_option() {
  local prompt="$1"
  shift
  local options=("$@")
  local i choice

  printf '\n%s\n' "$prompt" >&2
  for i in "${!options[@]}"; do
    printf '  %s) %s\n' "$((i + 1))" "${options[$i]}" >&2
  done

  while true; do
    read_input "Choose [1-${#options[@]}]: " choice
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#options[@]}" ]; then
      printf '%s' "${options[$((choice - 1))]}"
      return 0
    fi
    warn "Invalid choice."
  done
}

detect_package_manager() {
  if has_cmd apt-get; then PACKAGE_MANAGER="apt"; return; fi
  if has_cmd dnf; then PACKAGE_MANAGER="dnf"; return; fi
  if has_cmd yum; then PACKAGE_MANAGER="yum"; return; fi
  if has_cmd pacman; then PACKAGE_MANAGER="pacman"; return; fi
  if has_cmd apk; then PACKAGE_MANAGER="apk"; return; fi
  if has_cmd zypper; then PACKAGE_MANAGER="zypper"; return; fi
  PACKAGE_MANAGER="unknown"
}

install_packages() {
  local packages=("$@")
  [ "${#packages[@]}" -gt 0 ] || return 0

  case "$PACKAGE_MANAGER" in
    apt)
      as_root apt-get update
      as_root apt-get install -y "${packages[@]}"
      ;;
    dnf)
      as_root dnf install -y "${packages[@]}"
      ;;
    yum)
      as_root yum install -y "${packages[@]}"
      ;;
    pacman)
      as_root pacman -Sy --noconfirm --needed "${packages[@]}"
      ;;
    apk)
      as_root apk add --no-cache "${packages[@]}"
      ;;
    zypper)
      as_root zypper --non-interactive install "${packages[@]}"
      ;;
    *)
      warn "Unknown package manager. Please ensure these packages exist: ${packages[*]}"
      ;;
  esac
}

install_base_packages() {
  detect_package_manager
  log "Detected package manager: $PACKAGE_MANAGER"

  case "$PACKAGE_MANAGER" in
    apt)
      if [ "$DEPLOY_MODE" = "docker" ]; then
        install_packages ca-certificates curl
      else
        install_packages ca-certificates curl git tar xz-utils
      fi
      ;;
    dnf|yum|pacman|apk|zypper)
      if [ "$DEPLOY_MODE" = "docker" ]; then
        install_packages ca-certificates curl
      else
        install_packages ca-certificates curl git tar xz
      fi
      ;;
    *)
      if [ "$DEPLOY_MODE" = "docker" ]; then
        for cmd in curl; do has_cmd "$cmd" || die "Missing required command: $cmd"; done
      else
        for cmd in curl git tar; do has_cmd "$cmd" || die "Missing required command: $cmd"; done
      fi
      ;;
  esac
}

node_major() {
  if ! has_cmd node; then return 1; fi
  node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/'
}

ensure_node_major_at_least_22() {
  local major="$1"
  [[ "$major" =~ ^[0-9]+$ ]] && [ "$major" -ge 22 ]
}

validate_app_dir() {
  case "$APP_DIR" in
    /*) ;;
    *) die "APP_DIR must be an absolute path." ;;
  esac

  case "$APP_DIR" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/sys|/tmp|/usr|/var)
      die "Refusing unsafe APP_DIR: $APP_DIR"
      ;;
  esac

  case "$APP_DIR" in
    *[[:space:]]*) die "APP_DIR must not contain whitespace." ;;
  esac
}

validate_api_port() {
  local port="$1"
  [[ "$port" =~ ^[0-9]+$ ]] || die "API_PORT must be a number."
  [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || die "API_PORT must be between 1 and 65535."
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'x64' ;;
    aarch64|arm64) printf 'arm64' ;;
    armv7l) printf 'armv7l' ;;
    *) return 1 ;;
  esac
}

install_node_binary() {
  local arch archive url tmpdir target
  arch="$(detect_arch)" || die "Unsupported CPU architecture: $(uname -m)"
  archive="node-v${NODE_VERSION}-linux-${arch}.tar.xz"
  url="https://nodejs.org/dist/v${NODE_VERSION}/${archive}"
  tmpdir="$(mktemp -d)"
  target="/opt/node-v${NODE_VERSION}-linux-${arch}"

  log "Installing Node.js v${NODE_VERSION} from nodejs.org..."
  curl -fsSL "$url" -o "$tmpdir/$archive"
  as_root mkdir -p /opt
  as_root tar -xJf "$tmpdir/$archive" -C /opt
  as_root ln -sfn "$target" /opt/s12ryt-node
  rm -rf "$tmpdir"
  NODE_BIN_DIR="/opt/s12ryt-node/bin"
}

ensure_node() {
  local major=""
  if major="$(node_major)" && ensure_node_major_at_least_22 "$major"; then
    NODE_BIN_DIR="$(dirname "$(command -v node)")"
    log "Using existing Node.js: $(node -v)"
    return 0
  fi

  if [ -n "$major" ]; then
    warn "Existing Node.js major version is $major, but this project requires >=22."
  else
    warn "Node.js is not installed."
  fi

  install_node_binary
  export PATH="$NODE_BIN_DIR:$PATH"
  log "Installed Node.js: $(node -v)"
}

prepare_app_dir_for_runner() {
  local parent
  parent="$(dirname "$APP_DIR")"
  as_root mkdir -p "$parent"

  if [ -d "$APP_DIR" ]; then
    as_root chown -R "${ORIGINAL_UID}:${ORIGINAL_GID}" "$APP_DIR"
  else
    as_root mkdir -p "$APP_DIR"
    as_root chown "${ORIGINAL_UID}:${ORIGINAL_GID}" "$APP_DIR"
  fi
}

ensure_service_user() {
  if ! getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
    as_root groupadd --system "$SERVICE_GROUP"
  fi

  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    as_root useradd --system --gid "$SERVICE_GROUP" --home-dir "$APP_DIR/nodejs" --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
}

prepare_systemd_permissions() {
  ensure_service_user
  as_root mkdir -p "$APP_DIR/nodejs/data"
  as_root chown -R "${SERVICE_USER}:${SERVICE_GROUP}" "$APP_DIR"
  as_root chmod 700 "$APP_DIR/nodejs/data"
  as_root chmod 600 "$APP_DIR/nodejs/.env"
}

ensure_docker() {
  if has_cmd docker; then
    log "Using existing Docker: $(docker --version)"
    return 0
  fi

  warn "Docker is not installed. Trying package-manager installation."
  case "$PACKAGE_MANAGER" in
    apt) install_packages docker.io ;;
    dnf|yum) install_packages docker ;;
    pacman) install_packages docker ;;
    apk) install_packages docker ;;
    zypper) install_packages docker ;;
    *) die "Docker is missing and package manager is unknown." ;;
  esac

  if has_cmd systemctl; then
    as_root systemctl enable --now docker || true
  elif has_cmd service; then
    as_root service docker start || true
  fi

  has_cmd docker || die "Docker installation did not provide a docker command."
}

sync_repo() {
  [ "$DEPLOY_MODE" = "systemd" ] || die "Internal error: sync_repo is only allowed in systemd mode."

  APP_DIR="$(prompt_default "Install/update directory" "$APP_DIR")"
  validate_app_dir
  prepare_app_dir_for_runner

  if [ -d "$APP_DIR/.git" ]; then
    log "Updating existing repository in $APP_DIR"
    git -C "$APP_DIR" fetch origin "$REPO_BRANCH"
    git -C "$APP_DIR" checkout "$REPO_BRANCH"
    git -C "$APP_DIR" pull --ff-only origin "$REPO_BRANCH"
  elif [ -d "$APP_DIR" ] && [ -z "$(find "$APP_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    log "Cloning $REPO_URL to $APP_DIR"
    git clone --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
  elif [ -e "$APP_DIR" ]; then
    die "$APP_DIR exists but is not a git repository. Choose another APP_DIR or move it away."
  else
    log "Cloning $REPO_URL to $APP_DIR"
    git clone --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
  fi
}

prepare_docker_app_dir() {
  local default_dir="$APP_DIR"
  if [ "$APP_DIR" = "$DEFAULT_APP_DIR" ]; then
    default_dir="$DOCKER_APP_DIR"
  fi

  APP_DIR="$(prompt_default "Docker config/data directory" "$default_dir")"
  validate_app_dir
  prepare_app_dir_for_runner
  mkdir -p "$APP_DIR/nodejs/data"
  log "Using Docker config/data directory: $APP_DIR"
}

write_env_file() {
  local env_file="$APP_DIR/nodejs/.env"
  local bot_token admin_id api_port default_api_url database_path memory_limit

  mkdir -p "$APP_DIR/nodejs/data"

  if [ "$ACTION" = "Update existing deployment" ] && [ -f "$env_file" ]; then
    if confirm_default_yes "Keep existing $env_file"; then
      API_PORT_VALUE="$(grep -E '^API_PORT=' "$env_file" | tail -n 1 | cut -d= -f2- || true)"
      API_PORT_VALUE="${API_PORT_VALUE:-8000}"
      validate_api_port "$API_PORT_VALUE"
      log "Keeping existing $env_file"
      return 0
    fi
  fi

  if [ "$ENV_MODE" = "Use current environment variables" ]; then
    bot_token="${BOT_TOKEN:-}"
    admin_id="${ADMIN_ID:-}"
    api_port="${API_PORT:-8000}"
    default_api_url="${DEFAULT_API_URL:-http://localhost:${api_port}}"
    database_path="${DATABASE_PATH:-./data/bot.db}"
    memory_limit="${memory:-}"
    [ -n "$bot_token" ] || die "BOT_TOKEN is required when using environment variables."
    [ -n "$admin_id" ] || die "ADMIN_ID is required when using environment variables."
  else
    bot_token="$(prompt_secret "BOT_TOKEN")"
    admin_id="$(prompt_default "ADMIN_ID" "${ADMIN_ID:-}")"
    api_port="$(prompt_default "API_PORT" "${API_PORT:-8000}")"
    default_api_url="$(prompt_default "DEFAULT_API_URL" "${DEFAULT_API_URL:-http://localhost:${api_port}}")"
    database_path="$(prompt_default "DATABASE_PATH" "${DATABASE_PATH:-./data/bot.db}")"
    memory_limit="$(prompt_default "memory limit MB, empty for auto" "${memory:-}")"
    [ -n "$bot_token" ] || die "BOT_TOKEN cannot be empty."
    [ -n "$admin_id" ] || die "ADMIN_ID cannot be empty."
  fi

  validate_api_port "$api_port"
  API_PORT_VALUE="$api_port"

  umask 077
  cat > "$env_file" <<EOF
BOT_TOKEN=$bot_token
ADMIN_ID=$admin_id
API_PORT=$api_port
DATABASE_PATH=$database_path
DEFAULT_API_URL=$default_api_url
NODEJS_PLUGIN_PATHS=${NODEJS_PLUGIN_PATHS:-}
CLOUDFLARE_TUNNEL=
CLOUDFLARE_TOKEN=
GITHUB_MIRROR=${GITHUB_MIRROR:-}
NPM_REGISTRY=${NPM_REGISTRY:-}
EOF

  if [ -n "$memory_limit" ]; then
    printf 'memory=%s\n' "$memory_limit" >> "$env_file"
  fi

  chmod 600 "$env_file"
  log "Wrote $env_file"
}

build_node_app() {
  ensure_node
  export PATH="$NODE_BIN_DIR:$PATH"
  cd "$APP_DIR/nodejs"

  log "Installing Node.js dependencies..."
  npm ci --no-audit --no-fund
  log "Building Node.js app..."
  npm run build
  log "Pruning dev dependencies..."
  npm prune --omit=dev --no-audit --no-fund
}

install_systemd_service() {
  has_cmd systemctl || die "systemd is not available on this host. Choose Docker mode instead."
  local service_file="/etc/systemd/system/${SERVICE_NAME}.service"
  local node_path="$NODE_BIN_DIR"

  log "Writing systemd service: $service_file"
  as_root tee "$service_file" >/dev/null <<EOF
[Unit]
Description=s12ryt-tg-api Node.js service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_GROUP}
WorkingDirectory=${APP_DIR}/nodejs
Environment=NODE_ENV=production
Environment=PATH=${node_path}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=${node_path}/npm start
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF

  as_root systemctl daemon-reload
  as_root systemctl enable "$SERVICE_NAME"
  as_root systemctl restart "$SERVICE_NAME"
}

deploy_systemd() {
  build_node_app
  prepare_systemd_permissions
  install_systemd_service
}

deploy_docker() {
  [ "$DEPLOY_MODE" = "docker" ] || die "Internal error: deploy_docker is only allowed in docker mode."

  ensure_docker

  log "Pulling Docker image: $DOCKER_IMAGE"
  as_root docker pull "$DOCKER_IMAGE"

  if as_root docker ps -a --format '{{.Names}}' | grep -Fxq "$DOCKER_CONTAINER"; then
    log "Removing existing Docker container: $DOCKER_CONTAINER"
    as_root docker rm -f "$DOCKER_CONTAINER" >/dev/null
  fi

  mkdir -p "$APP_DIR/nodejs/data"
  as_root chown -R 1000:1000 "$APP_DIR/nodejs/data" || true
  log "Starting Docker container: $DOCKER_CONTAINER"
  as_root docker run -d \
    --name "$DOCKER_CONTAINER" \
    --restart unless-stopped \
    --env-file "$APP_DIR/nodejs/.env" \
    -p "${API_PORT_VALUE}:${API_PORT_VALUE}" \
    -v "$APP_DIR/nodejs/data:/app/nodejs/data" \
    "$DOCKER_IMAGE" >/dev/null
}

health_check() {
  local url="http://127.0.0.1:${API_PORT_VALUE}/health"
  local i
  log "Waiting for service health: $url"
  for i in $(seq 1 30); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "Health check passed: $url"
      return 0
    fi
    sleep 2
  done

  warn "Health check failed after 60 seconds."
  if [ "$DEPLOY_MODE" = "systemd" ] && has_cmd systemctl; then
    as_root systemctl --no-pager --full status "$SERVICE_NAME" || true
  elif [ "$DEPLOY_MODE" = "docker" ] && has_cmd docker; then
    as_root docker logs --tail 80 "$DOCKER_CONTAINER" || true
  fi
  die "Service did not become healthy."
}

print_summary() {
  cat <<EOF

Done.
Deployment mode: $DEPLOY_MODE
App directory:   $APP_DIR
API URL:         http://127.0.0.1:${API_PORT_VALUE}
Health:          http://127.0.0.1:${API_PORT_VALUE}/health

Useful commands:
  systemd logs:  journalctl -u ${SERVICE_NAME} -f
  systemd stop:  systemctl stop ${SERVICE_NAME}
  docker logs:   docker logs -f ${DOCKER_CONTAINER}
  docker stop:   docker stop ${DOCKER_CONTAINER}
EOF
}

main() {
  log "s12ryt-tg-api VPS installer/updater"

  ACTION="$(choose_option "What do you want to do?" "Install or reinstall" "Update existing deployment")"
  DEPLOY_MODE="$(choose_option "Choose deployment mode (docker pulls GHCR image and does not clone; systemd clones source and builds locally)" "docker" "systemd")"
  ENV_MODE="$(choose_option "How should .env be filled?" "Interactive input" "Use current environment variables")"

  install_base_packages

  case "$DEPLOY_MODE" in
    systemd)
      has_cmd systemctl || die "systemd is not available. Re-run and choose docker mode."
      ;;
    docker)
      ;;
    *) die "Unknown deployment mode: $DEPLOY_MODE" ;;
  esac

  if [ "$DEPLOY_MODE" = "systemd" ]; then
    log "systemd mode selected: cloning/updating source repository."
    sync_repo
  else
    log "Docker mode selected: using GHCR image, no repository clone."
    prepare_docker_app_dir
  fi
  write_env_file

  if [ "$DEPLOY_MODE" = "systemd" ]; then
    deploy_systemd
  else
    deploy_docker
  fi

  health_check
  print_summary
}

main "$@"
