#!/usr/bin/env bash
# PoolProx2 installer for Linux and macOS
#
# One-command install:
#   curl -fsSL https://raw.githubusercontent.com/priyo000/etteum-pool/main/install.sh | bash
#
# Or, after cloning:
#   bash install.sh

set -euo pipefail

REPO_URL="${POOLPROX_REPO:-https://github.com/priyo000/etteum-pool.git}"
INSTALL_DIR_DEFAULT="${POOLPROX_HOME:-$HOME/poolprox2}"

C_RESET='\033[0m'
C_BOLD='\033[1m'
C_DIM='\033[2m'
C_RED='\033[31m'
C_GREEN='\033[32m'
C_YELLOW='\033[33m'
C_BLUE='\033[34m'
C_CYAN='\033[36m'

step()  { printf "${C_CYAN}==>${C_RESET} ${C_BOLD}%s${C_RESET}\n" "$*"; }
info()  { printf "    %s\n" "$*"; }
warn()  { printf "${C_YELLOW}!!${C_RESET}  %s\n" "$*"; }
err()   { printf "${C_RED}xx${C_RESET}  %s\n" "$*" 1>&2; }
ok()    { printf "${C_GREEN}ok${C_RESET}  %s\n" "$*"; }

detect_os() {
  case "$(uname -s)" in
    Linux*)  echo "linux" ;;
    Darwin*) echo "macos" ;;
    *)       echo "unsupported" ;;
  esac
}

OS=$(detect_os)
if [[ "$OS" == "unsupported" ]]; then
  err "Unsupported OS: $(uname -s). Use install.ps1 on Windows."
  exit 1
fi

have() { command -v "$1" >/dev/null 2>&1; }

ensure_git() {
  if have git; then return; fi
  step "Installing git"
  if [[ "$OS" == "macos" ]]; then
    if have brew; then brew install git; else
      err "Install Homebrew first: https://brew.sh"; exit 1
    fi
  else
    if have apt-get; then sudo apt-get update && sudo apt-get install -y git
    elif have dnf; then sudo dnf install -y git
    elif have pacman; then sudo pacman -S --noconfirm git
    else err "Install git manually for your distro"; exit 1
    fi
  fi
}

ensure_bun() {
  if have bun; then return; fi
  step "Installing Bun"
  curl -fsSL https://bun.sh/install | bash >/dev/null
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! have bun; then
    err "Bun installation finished but 'bun' is not on PATH. Open a new shell and re-run."
    exit 1
  fi
  ok "Bun $(bun --version) installed"
}

ensure_python() {
  for cand in python3.12 python3.11 python3.10 python3; do
    if have "$cand"; then
      PYTHON_BIN="$cand"
      local ver
      ver=$("$cand" -c 'import sys;print("%d.%d"%sys.version_info[:2])')
      local major minor; IFS=. read -r major minor <<<"$ver"
      if [[ "$major" -ge 3 && "$minor" -ge 10 ]]; then return; fi
    fi
  done
  step "Installing Python 3.11+"
  if [[ "$OS" == "macos" ]]; then
    if have brew; then brew install python@3.11; PYTHON_BIN=python3.11
    else err "Install Python 3.10+ manually (or install Homebrew)"; exit 1
    fi
  else
    if have apt-get; then sudo apt-get update && sudo apt-get install -y python3 python3-venv python3-pip; PYTHON_BIN=python3
    elif have dnf; then sudo dnf install -y python3 python3-pip; PYTHON_BIN=python3
    elif have pacman; then sudo pacman -S --noconfirm python python-pip; PYTHON_BIN=python3
    else err "Install Python 3.10+ manually for your distro"; exit 1
    fi
  fi
  ok "Python $($PYTHON_BIN --version 2>&1) installed"
}

clone_or_update_repo() {
  if [[ -f "package.json" ]] && grep -q '"name": "poolprox2"' package.json 2>/dev/null; then
    PROJECT_DIR="$(pwd)"
    step "Using existing checkout: $PROJECT_DIR"
    if [[ -d ".git" ]]; then
      info "Pulling latest..."
      git pull --ff-only || warn "git pull failed (continuing with current checkout)"
    fi
    return
  fi

  if [[ -d "$INSTALL_DIR_DEFAULT/.git" ]]; then
    PROJECT_DIR="$INSTALL_DIR_DEFAULT"
    step "Updating existing checkout at $PROJECT_DIR"
    (cd "$PROJECT_DIR" && git pull --ff-only) || warn "git pull failed"
  else
    PROJECT_DIR="$INSTALL_DIR_DEFAULT"
    step "Cloning $REPO_URL → $PROJECT_DIR"
    git clone --depth=1 "$REPO_URL" "$PROJECT_DIR"
  fi
  cd "$PROJECT_DIR"
}

write_env_if_missing() {
  step "Configuring .env"
  if [[ -f .env ]]; then
    info ".env already exists, leaving untouched"
    return
  fi
  cp .env.example .env

  local key
  if have openssl; then
    key=$(openssl rand -hex 16)
  elif [[ -r /dev/urandom ]]; then
    key=$(head -c 16 /dev/urandom | xxd -p 2>/dev/null || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
  else
    key="$(date +%s)$(echo $RANDOM$RANDOM)"; key=${key:0:32}
  fi
  if [[ -n "$key" ]]; then
    if [[ "$OS" == "macos" ]]; then
      sed -i '' "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$key|" .env
    else
      sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$key|" .env
    fi
    ok "Generated random ENCRYPTION_KEY"
  fi
}

install_node_deps() {
  step "Installing JS dependencies (bun install)"
  bun install --silent
  (cd dashboard && bun install --silent)
  ok "JS dependencies installed"
}

setup_python_venv() {
  step "Setting up Python venv at scripts/auth/.venv"
  if [[ ! -d scripts/auth/.venv ]]; then
    "$PYTHON_BIN" -m venv scripts/auth/.venv
  fi

  local pip="scripts/auth/.venv/bin/pip"
  "$pip" install --upgrade pip wheel >/dev/null
  "$pip" install -r scripts/auth/requirements.txt
  ok "Python deps installed"

  step "Installing Playwright + Camoufox browsers (this can take a few minutes)"
  scripts/auth/.venv/bin/python -m playwright install chromium >/dev/null 2>&1 || warn "Playwright Chromium install failed (you can re-run later)"
  scripts/auth/.venv/bin/python -m camoufox fetch >/dev/null 2>&1 || warn "Camoufox fetch failed (you can re-run later)"
  ok "Browsers ready"
}

build_dashboard() {
  step "Building dashboard (production)"
  (cd dashboard && bun run build) || { err "Dashboard build failed"; exit 1; }
  ok "Dashboard built"
}

run_migrations_if_db() {
  step "Running database migrations"
  if bun src/db/migrate.ts 2>&1; then
    ok "Migrations applied"
  else
    warn "Migrations failed. Make sure PostgreSQL is running and DATABASE_URL in .env is correct."
    info "After fixing, run: bun run migrate"
  fi
}

install_cli_symlink() {
  if [[ -z "${POOLPROX_INSTALL_CLI:-}" ]]; then return; fi
  local target="$HOME/.local/bin"
  mkdir -p "$target"
  ln -sf "$PROJECT_DIR/poolprox" "$target/poolprox"
  chmod +x "$PROJECT_DIR/poolprox"
  ok "Linked $target/poolprox -> $PROJECT_DIR/poolprox"
  case ":$PATH:" in
    *":$target:"*) ;;
    *) info "Add to PATH: export PATH=\"$target:\$PATH\"" ;;
  esac
}

main() {
  printf "\n${C_BOLD}${C_BLUE}PoolProx2 Installer${C_RESET}  ${C_DIM}(%s)${C_RESET}\n\n" "$OS"

  ensure_git
  ensure_bun
  ensure_python
  clone_or_update_repo

  cd "$PROJECT_DIR"
  chmod +x poolprox 2>/dev/null || true

  write_env_if_missing
  install_node_deps
  setup_python_venv
  build_dashboard
  run_migrations_if_db
  install_cli_symlink

  printf "\n${C_GREEN}${C_BOLD}Done.${C_RESET}  PoolProx2 is installed at ${C_BOLD}%s${C_RESET}\n\n" "$PROJECT_DIR"
  cat <<EOF
Next steps:
  1. Edit .env if needed:
       \$EDITOR $PROJECT_DIR/.env
  2. Make sure PostgreSQL is running and DATABASE_URL points to a reachable DB.
       Quick local DB: createdb pool_proxy
  3. Start the server:
       cd $PROJECT_DIR && ./poolprox start
       or:  bun start
  4. Open the dashboard:
       http://localhost:1631

Tip: re-run this installer any time to pull updates and rebuild.
EOF
}

main "$@"
