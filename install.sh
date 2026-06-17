#!/usr/bin/env bash
# Etteum Pool installer for Linux and macOS
#
# One-command install:
#   curl -fsSL https://raw.githubusercontent.com/levanza1358/etteum-pool/main/install.sh | bash
#
# Or, after cloning:
#   bash install.sh

set -euo pipefail

# Auto-yes: skip prompts when piped or --yes flag
AUTO_YES=false
if [[ ! -t 0 ]] || [[ "${1:-}" == "--yes" ]] || [[ "${1:-}" == "-y" ]]; then
  AUTO_YES=true
fi

REPO_URL="${ETTEUM_REPO:-https://github.com/levanza1358/etteum-pool.git}"
INSTALL_DIR_DEFAULT="${ETTEUM_HOME:-$HOME/etteum-pool}"

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

# Initialise PYTHON_BIN so it's always defined
PYTHON_BIN=""

show_summary() {
  printf "\n${C_BOLD}${C_BLUE}Etteum Pool${C_RESET} — AI Proxy Pool for Multiple Providers\n\n"

  # Check what needs to be installed
  local needs_git=false needs_bun=false needs_python=false
  local total_size=0
  local items=()

  have git || { needs_git=true; items+=("  • Git                          ~50 MB"); ((total_size += 50)); }
  have bun || { needs_bun=true; items+=("  • Bun runtime                  ~50 MB"); ((total_size += 50)); }

  local has_python=false
  for cand in python3.12 python3.11 python3.10 python3; do
    if have "$cand"; then
      has_python=true
      break
    fi
  done
  $has_python || { needs_python=true; items+=("  • Python 3.11+                 ~100 MB"); ((total_size += 100)); }

  items+=("  • Node.js dependencies         ~200 MB")
  ((total_size += 200))
  items+=("  • Python packages (venv)       ~150 MB")
  ((total_size += 150))
  items+=("  • Playwright Chromium          ~175 MB")
  ((total_size += 175))
  items+=("  • Camoufox browser             ~150 MB")
  ((total_size += 150))
  items+=("  • Dashboard build              ~50 MB")
  ((total_size += 50))

  printf "${C_BOLD}This will install:${C_RESET}\n"
  for item in "${items[@]}"; do
    printf "%s\n" "$item"
  done
  printf "\n"
  printf "${C_BOLD}Estimated total size:${C_RESET} ~%d MB\n" "$total_size"
  printf "${C_BOLD}Install location:${C_RESET}     %s\n" "$INSTALL_DIR_DEFAULT"
  printf "\n"

  if $needs_git || $needs_bun || $needs_python; then
    printf "${C_YELLOW}Note:${C_RESET} System dependencies (Git/Bun/Python) will be installed via package manager.\n"
    printf "      This may require ${C_BOLD}sudo${C_RESET} password.\n\n"
  fi

  if $AUTO_YES; then
    printf "Auto-confirming (piped or --yes flag)\n\n"
  else
    printf "Do you want to continue? [Y/n] "
    read -r answer
    case "$answer" in
      [nN]|[nN][oO]) printf "Installation cancelled.\n"; exit 0 ;;
    esac
    printf "\n"
  fi
}

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
  if ! have git; then
    err "git installation finished but 'git' is not on PATH."
    exit 1
  fi
  ok "Git installed"
}

ensure_bun() {
  if have bun; then
    ok "Bun $(bun --version) already installed"
    return
  fi
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
      ver=$("$cand" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo "0.0")
      local major minor; IFS=. read -r major minor <<<"$ver"
      if [[ "$major" -ge 3 && "$minor" -ge 10 ]]; then
        ok "Python $ver found ($cand)"
        return
      fi
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
  if [[ -z "$PYTHON_BIN" ]] || ! have "$PYTHON_BIN"; then
    err "Python installation failed — '$PYTHON_BIN' not found on PATH."
    exit 1
  fi
  ok "Python $($PYTHON_BIN --version 2>&1) installed"
}

# On Debian/Ubuntu, python3-venv is a separate package.
# If `python3 -m venv` fails, try to install it.
ensure_venv_module() {
  if "$PYTHON_BIN" -m venv --help >/dev/null 2>&1; then return; fi
  step "Installing python3-venv package"
  if have apt-get; then
    sudo apt-get update && sudo apt-get install -y python3-venv
  fi
  if ! "$PYTHON_BIN" -m venv --help >/dev/null 2>&1; then
    err "Python venv module is not available. Install 'python3-venv' for your distro and re-run."
    exit 1
  fi
  ok "python3-venv installed"
}

clone_or_update_repo() {
  if [[ -f "package.json" ]] && grep -q '"name": "etteum-pool"' package.json 2>/dev/null; then
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
    info ".env already exists, checking for missing keys..."
  else
    cp .env.example .env
    info "Created .env from .env.example"
  fi

  # Generate ENCRYPTION_KEY if it's still the default placeholder
  local current_key
  current_key=$(grep '^ENCRYPTION_KEY=' .env 2>/dev/null | cut -d= -f2- || echo "")
  if [[ -z "$current_key" || "$current_key" == "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6" ]]; then
    local key=""
    if have openssl; then
      key=$(openssl rand -hex 16)
    elif [[ -r /dev/urandom ]]; then
      key=$(head -c 16 /dev/urandom | xxd -p 2>/dev/null || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
    else
      key="$(date +%s)$(echo $RANDOM$RANDOM)"; key=${key:0:32}
    fi
    if [[ -n "$key" ]]; then
      if grep -q '^ENCRYPTION_KEY=' .env; then
        if [[ "$OS" == "macos" ]]; then
          sed -i '' "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$key|" .env
        else
          sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$key|" .env
        fi
      else
        echo "ENCRYPTION_KEY=$key" >> .env
      fi
      ok "Generated random ENCRYPTION_KEY"
    fi
  fi

  # Ensure PYTHON_PATH is empty (auto-detect) or correct for this OS
  if ! grep -q '^PYTHON_PATH=' .env; then
    echo "PYTHON_PATH=" >> .env
    info "Added PYTHON_PATH= (auto-detect)"
  else
    # If it has a Windows path on Linux or vice versa, clear it for auto-detect
    local py_path
    py_path=$(grep '^PYTHON_PATH=' .env | cut -d= -f2- || echo "")
    if [[ -n "$py_path" ]]; then
      # Check if the configured path actually exists
      if [[ ! -x "$py_path" ]] && [[ ! -f "$py_path" ]]; then
        warn "PYTHON_PATH=$py_path does not exist — clearing for auto-detect"
        if [[ "$OS" == "macos" ]]; then
          sed -i '' "s|^PYTHON_PATH=.*|PYTHON_PATH=|" .env
        else
          sed -i "s|^PYTHON_PATH=.*|PYTHON_PATH=|" .env
        fi
      fi
    fi
  fi

  # Ensure other required keys exist
  for key_name in PORT DASHBOARD_PORT API_KEY DATABASE_PATH AUTH_SCRIPT_PATH AUTH_SCRIPT_CWD; do
    if ! grep -q "^${key_name}=" .env; then
      local default_val
      default_val=$(grep "^${key_name}=" .env.example 2>/dev/null | cut -d= -f2- || echo "")
      echo "${key_name}=${default_val}" >> .env
      info "Added missing ${key_name}"
    fi
  done
}

install_node_deps() {
  step "Installing JS dependencies"

  # Verify bun is available
  if ! have bun; then
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    if ! have bun; then
      err "bun is not on PATH. Please open a new terminal and re-run the installer."
      exit 1
    fi
  fi

  info "Installing root dependencies..."
  if ! bun install; then
    err "bun install failed in project root"
    info "Try running manually: cd $PROJECT_DIR && bun install"
    exit 1
  fi

  info "Installing dashboard dependencies..."
  if ! (cd dashboard && bun install); then
    err "bun install failed in dashboard/"
    info "Try running manually: cd $PROJECT_DIR/dashboard && bun install"
    exit 1
  fi

  ok "JS dependencies installed"
}

setup_python_venv() {
  local venv_dir="scripts/auth/.venv"
  local pip="$venv_dir/bin/pip"
  local venv_python="$venv_dir/bin/python"

  step "Setting up Python venv at $venv_dir"

  # Ensure venv module is available (Debian/Ubuntu need python3-venv)
  ensure_venv_module

  if [[ ! -d "$venv_dir" ]]; then
    info "Creating virtual environment..."
    if ! "$PYTHON_BIN" -m venv "$venv_dir"; then
      err "Failed to create Python venv at $venv_dir"
      info "Try manually: $PYTHON_BIN -m venv $venv_dir"
      info "On Ubuntu/Debian, you may need: sudo apt install python3-venv"
      exit 1
    fi
  fi

  # Validate venv was created correctly
  if [[ ! -f "$venv_python" ]]; then
    err "Python venv created but $venv_python not found!"
    info "Expected: $venv_dir/bin/python"
    info "Try deleting $venv_dir and re-running the installer."
    exit 1
  fi

  if [[ ! -f "$pip" ]]; then
    err "Python venv created but pip not found at $pip"
    info "Try deleting $venv_dir and re-running the installer."
    exit 1
  fi

  info "Upgrading pip..."
  "$pip" install --upgrade pip wheel 2>&1 | tail -1

  info "Installing Python packages (this may take a minute)..."
  if ! "$pip" install -r scripts/auth/requirements.txt 2>&1 | tail -5; then
    err "pip install failed"
    info "Try manually: $pip install -r scripts/auth/requirements.txt"
    exit 1
  fi
  ok "Python deps installed"

  step "Installing browsers (Playwright + Camoufox — this can take a few minutes)"
  info "Installing Playwright Chromium..."
  if "$venv_python" -m playwright install chromium 2>&1 | tail -3; then
    ok "Playwright Chromium installed"
  else
    warn "Playwright Chromium install failed (you can re-run later)"
    info "  Manual: $venv_python -m playwright install chromium"
  fi

  info "Fetching Camoufox browser..."
  if "$venv_python" -m camoufox fetch 2>&1 | tail -3; then
    ok "Camoufox browser installed"
  else
    warn "Camoufox fetch failed (you can re-run later)"
    info "  Manual: $venv_python -m camoufox fetch"
  fi
}

build_dashboard() {
  step "Building dashboard (production)"
  if ! (cd dashboard && bun run build); then
    err "Dashboard build failed"
    info "Try manually: cd $PROJECT_DIR/dashboard && bun run build"
    exit 1
  fi
  ok "Dashboard built"
}

run_migrations() {
  step "Running database migrations"
  if bun src/db/migrate.ts 2>&1; then
    ok "Migrations applied"
  else
    warn "Migrations failed. Database will be created on first run."
    info "After first run, you can re-run: bun src/db/migrate.ts"
  fi
}

install_cli_symlink() {
  step "Installing CLI commands"
  local target="$HOME/.local/bin"
  mkdir -p "$target"

  # Link etteum command
  ln -sf "$PROJECT_DIR/etteum" "$target/etteum"
  chmod +x "$PROJECT_DIR/etteum"

  ok "Linked $target/etteum -> $PROJECT_DIR/etteum"

  case ":$PATH:" in
    *":$target:"*) ;;
    *) warn "Add to PATH: export PATH=\"$target:\$PATH\"" ;;
  esac
}

main() {
  printf "\n${C_BOLD}${C_BLUE}Etteum Pool Installer${C_RESET}  ${C_DIM}(%s)${C_RESET}\n" "$OS"

  show_summary

  ensure_git
  ensure_bun
  ensure_python
  clone_or_update_repo

  cd "$PROJECT_DIR"
  chmod +x etteum 2>/dev/null || true

  write_env_if_missing
  install_node_deps
  setup_python_venv
  build_dashboard
  run_migrations
  install_cli_symlink

  printf "\n${C_GREEN}${C_BOLD}✓ Installation complete!${C_RESET}\n\n"
  printf "Etteum Pool is installed at: ${C_BOLD}%s${C_RESET}\n\n" "$PROJECT_DIR"

  cat <<EOF
${C_BOLD}Quick Start:${C_RESET}

  1. Start the server:
     ${C_CYAN}etteum start${C_RESET}
     or: cd $PROJECT_DIR && ./etteum start

  2. Open the dashboard:
     ${C_CYAN}http://localhost:1931${C_RESET}

  3. Add accounts via the dashboard UI

${C_BOLD}Useful Commands:${C_RESET}

  etteum status     # Check server status
  etteum logs       # View server logs
  etteum stop       # Stop the server
  etteum restart    # Restart the server

${C_DIM}Tip: re-run this installer any time to pull updates and rebuild.${C_RESET}
EOF
}

main "$@"
