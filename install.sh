#!/usr/bin/env bash
# Etteum Pool installer for Linux and macOS (also WSL).
#
# One-command install:
#   curl -fsSL https://raw.githubusercontent.com/priyo000/etteum/main/install.sh | bash
#
# Or after cloning:
#   bash install.sh
#
# Environment variables (all optional):
#   ETTEUM_HOME       Install directory (default: ~/etteum-pool)
#   ETTEUM_REPO       Repo URL (default: github.com/priyo000/etteum-pool)
#   ETTEUM_YES=1      Skip confirmation prompts (for CI / unattended installs)
#   ETTEUM_BRANCH     Branch to clone (default: main)
#   ETTEUM_NO_CLI=1   Skip the ~/.local/bin/etteum symlink
#   ETTEUM_SKIP_BROWSERS=1  Skip Playwright/Camoufox download (needed for auth bot)

set -euo pipefail

REPO_URL="${ETTEUM_REPO:-git@github.com:priyo000/etteum.git}"
INSTALL_DIR_DEFAULT="${ETTEUM_HOME:-$HOME/etteum-pool}"
BRANCH="${ETTEUM_BRANCH:-main}"
ASSUME_YES="${ETTEUM_YES:-0}"

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

have() { command -v "$1" >/dev/null 2>&1; }

# Detect OS + distro family
OS=""
DISTRO_FAMILY=""
detect_os() {
  case "$(uname -s)" in
    Linux*)
      OS="linux"
      if [[ -r /etc/os-release ]]; then
        # shellcheck source=/dev/null
        . /etc/os-release
        case "${ID_LIKE:-$ID}" in
          *debian*|*ubuntu*) DISTRO_FAMILY="debian" ;;
          *rhel*|*fedora*|*centos*) DISTRO_FAMILY="rhel" ;;
          *arch*) DISTRO_FAMILY="arch" ;;
          *suse*) DISTRO_FAMILY="suse" ;;
          *alpine*) DISTRO_FAMILY="alpine" ;;
          *) DISTRO_FAMILY="unknown" ;;
        esac
      fi
      # WSL detection (informational)
      if grep -qi microsoft /proc/version 2>/dev/null; then
        info "Detected WSL — installation will proceed on the Linux side."
      fi
      ;;
    Darwin*) OS="macos" ;;
    FreeBSD*|OpenBSD*|NetBSD*)
      err "BSD detected. Etteum Pool is tested on Linux/macOS/Windows only — proceed at your own risk."
      OS="linux"  # try anyway; pkg managers differ but Bun & Python work
      ;;
    *)
      err "Unsupported OS: $(uname -s). Use install.ps1 on Windows."
      exit 1
      ;;
  esac
}
detect_os

# Initialise PYTHON_BIN so it's always defined
PYTHON_BIN=""
PROJECT_DIR=""

# ── Pretty banner & summary ───────────────────────────────────────────
show_summary() {
  printf "\n${C_BOLD}${C_BLUE}Etteum Pool${C_RESET} — AI Proxy Pool for Multiple Providers\n\n"

  local needs_git=false needs_bun=false needs_python=false
  local total_size=0
  local items=()

  have git || { needs_git=true; items+=("  • Git                          ~50 MB"); ((total_size += 50)); }
  have bun || { needs_bun=true; items+=("  • Bun runtime                  ~50 MB"); ((total_size += 50)); }

  local has_python=false
  for cand in python3.13 python3.12 python3.11 python3.10 python3; do
    if have "$cand"; then
      has_python=true
      break
    fi
  done
  $has_python || { needs_python=true; items+=("  • Python 3.10+                 ~100 MB"); ((total_size += 100)); }

  items+=("  • Node.js dependencies         ~200 MB")
  ((total_size += 200))
  items+=("  • Python packages (venv)       ~150 MB")
  ((total_size += 150))
  if [[ "${ETTEUM_SKIP_BROWSERS:-0}" != "1" ]]; then
    items+=("  • Playwright Chromium          ~175 MB")
    ((total_size += 175))
    items+=("  • Camoufox browser             ~150 MB")
    ((total_size += 150))
  fi
  items+=("  • Dashboard build              ~50 MB")
  ((total_size += 50))

  printf "${C_BOLD}This will install:${C_RESET}\n"
  for item in "${items[@]}"; do
    printf "%s\n" "$item"
  done
  printf "\n"
  printf "${C_BOLD}Estimated total size:${C_RESET} ~%d MB\n" "$total_size"
  printf "${C_BOLD}Install location:${C_RESET}     %s\n" "$INSTALL_DIR_DEFAULT"
  if [[ "$OS" == "linux" ]]; then
    printf "${C_BOLD}Distro family:${C_RESET}        %s\n" "${DISTRO_FAMILY:-unknown}"
  fi
  printf "\n"

  if $needs_git || $needs_bun || $needs_python; then
    printf "${C_YELLOW}Note:${C_RESET} System dependencies (Git/Bun/Python) will be installed via package manager.\n"
    printf "      This may require ${C_BOLD}sudo${C_RESET} password.\n\n"
  fi

  if [[ "$ASSUME_YES" == "1" ]]; then
    printf "${C_DIM}ETTEUM_YES=1 set — skipping confirmation.${C_RESET}\n\n"
    return
  fi

  # If stdin isn't a tty (e.g. piped from curl), default to yes — otherwise the
  # script just hangs on `read`. Users opt out by exporting ETTEUM_YES=0 and
  # running the script from a terminal.
  if [[ ! -t 0 ]]; then
    printf "${C_DIM}Stdin is not a TTY (piped install) — proceeding automatically.${C_RESET}\n\n"
    return
  fi

  printf "Do you want to continue? [Y/n] "
  read -r answer
  case "$answer" in
    [nN]|[nN][oO]) printf "Installation cancelled.\n"; exit 0 ;;
  esac
  printf "\n"
}

# ── Tool installers (idempotent) ──────────────────────────────────────

ensure_basics() {
  # curl + unzip are required for Bun's installer
  local missing=()
  have curl  || missing+=(curl)
  have unzip || missing+=(unzip)

  if [[ ${#missing[@]} -eq 0 ]]; then return; fi
  step "Installing prerequisites: ${missing[*]}"
  case "$OS:$DISTRO_FAMILY" in
    macos:*)    have brew && brew install "${missing[@]}" ;;
    linux:debian) sudo apt-get update -y && sudo apt-get install -y "${missing[@]}" ;;
    linux:rhel)   sudo dnf install -y "${missing[@]}" || sudo yum install -y "${missing[@]}" ;;
    linux:arch)   sudo pacman -S --noconfirm "${missing[@]}" ;;
    linux:suse)   sudo zypper -n install "${missing[@]}" ;;
    linux:alpine) sudo apk add --no-cache "${missing[@]}" ;;
    *) err "Install ${missing[*]} manually for your distro and re-run."; exit 1 ;;
  esac
}

ensure_git() {
  if have git; then ok "Git $(git --version | awk '{print $3}') already installed"; return; fi
  step "Installing git"
  case "$OS:$DISTRO_FAMILY" in
    macos:*)
      if have brew; then brew install git
      else
        info "Triggering Apple's CLT installer (will pop a GUI dialog)..."
        xcode-select --install 2>/dev/null || true
        err "Install git via Xcode Command-Line Tools or Homebrew, then re-run."; exit 1
      fi ;;
    linux:debian) sudo apt-get update -y && sudo apt-get install -y git ;;
    linux:rhel)   sudo dnf install -y git || sudo yum install -y git ;;
    linux:arch)   sudo pacman -S --noconfirm git ;;
    linux:suse)   sudo zypper -n install git ;;
    linux:alpine) sudo apk add --no-cache git ;;
    *) err "Install git manually for your distro"; exit 1 ;;
  esac
  if ! have git; then err "git installation finished but 'git' is not on PATH."; exit 1; fi
  ok "Git installed"
}

ensure_bun() {
  if have bun; then
    ok "Bun $(bun --version) already installed"
    return
  fi
  step "Installing Bun"
  if ! curl -fsSL https://bun.sh/install | bash; then
    err "Bun install failed. Check network connectivity and re-run."
    exit 1
  fi
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! have bun; then
    err "Bun installation finished but 'bun' is not on PATH."
    info "Add to PATH manually: export PATH=\"\$HOME/.bun/bin:\$PATH\""
    info "Then re-run this installer."
    exit 1
  fi
  ok "Bun $(bun --version) installed"
}

ensure_python() {
  for cand in python3.13 python3.12 python3.11 python3.10 python3; do
    if have "$cand"; then
      PYTHON_BIN="$cand"
      local ver major minor
      ver=$("$cand" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo "0.0")
      IFS=. read -r major minor <<<"$ver"
      if [[ "$major" -ge 3 && "$minor" -ge 10 ]]; then
        ok "Python $ver found ($cand)"
        return
      fi
    fi
  done
  step "Installing Python 3.11+"
  case "$OS:$DISTRO_FAMILY" in
    macos:*)
      if have brew; then brew install python@3.11 && PYTHON_BIN=python3.11
      else err "Install Python 3.10+ manually (or install Homebrew: https://brew.sh)"; exit 1
      fi ;;
    linux:debian)
      sudo apt-get update -y && sudo apt-get install -y python3 python3-venv python3-pip
      PYTHON_BIN=python3 ;;
    linux:rhel)
      sudo dnf install -y python3 python3-pip || sudo yum install -y python3 python3-pip
      PYTHON_BIN=python3 ;;
    linux:arch)
      sudo pacman -S --noconfirm python python-pip; PYTHON_BIN=python3 ;;
    linux:suse)
      sudo zypper -n install python3 python3-pip python3-venv; PYTHON_BIN=python3 ;;
    linux:alpine)
      sudo apk add --no-cache python3 py3-pip py3-virtualenv; PYTHON_BIN=python3 ;;
    *) err "Install Python 3.10+ manually for your distro"; exit 1 ;;
  esac
  if [[ -z "$PYTHON_BIN" ]] || ! have "$PYTHON_BIN"; then
    err "Python installation finished but '$PYTHON_BIN' is not on PATH."
    exit 1
  fi
  ok "Python $($PYTHON_BIN --version 2>&1) installed"
}

# Debian/Ubuntu ship `python3 -m venv` as a separate package.
ensure_venv_module() {
  if "$PYTHON_BIN" -m venv --help >/dev/null 2>&1; then return; fi
  step "Installing python3-venv package"
  if [[ "$DISTRO_FAMILY" == "debian" ]]; then
    sudo apt-get update -y && sudo apt-get install -y python3-venv
  fi
  if ! "$PYTHON_BIN" -m venv --help >/dev/null 2>&1; then
    err "Python venv module is not available. Install 'python3-venv' (or virtualenv) for your distro and re-run."
    exit 1
  fi
  ok "python3-venv installed"
}

# ── Repo & config ─────────────────────────────────────────────────────

clone_or_update_repo() {
  if [[ -f "package.json" ]] && grep -q '"name": *"etteum-pool"' package.json 2>/dev/null; then
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
    step "Cloning $REPO_URL → $PROJECT_DIR (branch: $BRANCH)"
    git clone --depth=1 --branch "$BRANCH" "$REPO_URL" "$PROJECT_DIR"
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

  # Auto-rotate API_KEY off the default if user kept the placeholder
  local current_api
  current_api=$(grep '^API_KEY=' .env 2>/dev/null | cut -d= -f2- || echo "")
  if [[ "$current_api" == "pool-proxy-secret-key" ]]; then
    local new_api
    if have openssl; then new_api=$(openssl rand -hex 24)
    else new_api=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
    fi
    if [[ "$OS" == "macos" ]]; then
      sed -i '' "s|^API_KEY=.*|API_KEY=$new_api|" .env
    else
      sed -i "s|^API_KEY=.*|API_KEY=$new_api|" .env
    fi
    ok "Generated random API_KEY"
    info "  Your API key: $new_api"
    info "  Clients send this as: Authorization: Bearer <api_key>"
  fi

  # Ensure PYTHON_PATH is empty (auto-detect) or correct for this OS
  if ! grep -q '^PYTHON_PATH=' .env; then
    echo "PYTHON_PATH=" >> .env
    info "Added PYTHON_PATH= (auto-detect)"
  else
    local py_path
    py_path=$(grep '^PYTHON_PATH=' .env | cut -d= -f2- || echo "")
    if [[ -n "$py_path" ]] && [[ ! -x "$py_path" ]] && [[ ! -f "$py_path" ]]; then
      warn "PYTHON_PATH=$py_path does not exist — clearing for auto-detect"
      if [[ "$OS" == "macos" ]]; then
        sed -i '' "s|^PYTHON_PATH=.*|PYTHON_PATH=|" .env
      else
        sed -i "s|^PYTHON_PATH=.*|PYTHON_PATH=|" .env
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

# ── Heavy steps with retry ────────────────────────────────────────────

# Run cmd up to 3 times with exponential backoff. Useful for flaky network steps.
retry() {
  local n=0 max=3 delay=3
  while true; do
    if "$@"; then return 0; fi
    n=$((n + 1))
    if [[ $n -ge $max ]]; then return 1; fi
    warn "Command failed (attempt $n/$max). Retrying in ${delay}s..."
    sleep "$delay"
    delay=$((delay * 2))
  done
}

install_node_deps() {
  step "Installing JS dependencies"
  if ! have bun; then
    export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
    export PATH="$BUN_INSTALL/bin:$PATH"
    if ! have bun; then
      err "bun is not on PATH. Open a new terminal and re-run the installer."
      exit 1
    fi
  fi

  info "Installing root dependencies..."
  if ! retry bun install; then
    err "bun install failed in project root"
    info "Try manually: cd $PROJECT_DIR && bun install"
    exit 1
  fi

  info "Installing dashboard dependencies..."
  if ! retry bash -c "cd dashboard && bun install"; then
    err "bun install failed in dashboard/"
    info "Try manually: cd $PROJECT_DIR/dashboard && bun install"
    exit 1
  fi

  ok "JS dependencies installed"
}

setup_python_venv() {
  local venv_dir="scripts/auth/.venv"
  local pip="$venv_dir/bin/pip"
  local venv_python="$venv_dir/bin/python"

  step "Setting up Python venv at $venv_dir"
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

  if [[ ! -f "$venv_python" ]]; then
    err "Python venv created but $venv_python not found!"
    info "Try deleting $venv_dir and re-running the installer."
    exit 1
  fi
  if [[ ! -f "$pip" ]]; then
    err "Python venv created but pip not found at $pip"
    info "Try deleting $venv_dir and re-running the installer."
    exit 1
  fi

  info "Upgrading pip..."
  retry "$pip" install --upgrade pip wheel >/dev/null 2>&1 || warn "pip upgrade failed (continuing)"

  info "Installing Python packages (this may take a minute)..."
  if ! retry "$pip" install -r scripts/auth/requirements.txt; then
    err "pip install failed"
    info "Try manually: $pip install -r scripts/auth/requirements.txt"
    info "If you're behind a corporate proxy, set HTTPS_PROXY before re-running."
    exit 1
  fi
  ok "Python deps installed"

  if [[ "${ETTEUM_SKIP_BROWSERS:-0}" == "1" ]]; then
    warn "ETTEUM_SKIP_BROWSERS=1 — skipping Playwright/Camoufox download."
    warn "  Auth bot will fail until you run: $venv_python -m playwright install chromium && $venv_python -m camoufox fetch"
    return
  fi

  step "Installing browsers (Playwright + Camoufox — this can take a few minutes)"
  info "Installing Playwright Chromium..."
  if retry "$venv_python" -m playwright install chromium; then
    ok "Playwright Chromium installed"
  else
    warn "Playwright Chromium install failed (you can re-run later)"
    info "  Manual: $venv_python -m playwright install chromium"
  fi

  info "Fetching Camoufox browser..."
  if retry "$venv_python" -m camoufox fetch; then
    ok "Camoufox browser installed"
  else
    warn "Camoufox fetch failed (you can re-run later)"
    info "  Manual: $venv_python -m camoufox fetch"
  fi
}

build_dashboard() {
  step "Building dashboard (production)"
  if ! retry bash -c "cd dashboard && bun run build"; then
    err "Dashboard build failed"
    info "Try manually: cd $PROJECT_DIR/dashboard && bun run build"
    exit 1
  fi
  ok "Dashboard built"
}

run_migrations() {
  step "Running database migrations"
  mkdir -p "$PROJECT_DIR/data"
  if bun src/db/migrate.ts 2>&1; then
    ok "Migrations applied"
  else
    warn "Migrations failed. Database will be created on first run."
    info "After first run, you can re-run: bun src/db/migrate.ts"
  fi
}

install_cli_symlink() {
  if [[ "${ETTEUM_NO_CLI:-0}" == "1" ]]; then
    warn "ETTEUM_NO_CLI=1 — skipping CLI symlink"
    return
  fi
  step "Installing CLI commands"
  local target="$HOME/.local/bin"
  mkdir -p "$target"
  ln -sf "$PROJECT_DIR/etteum" "$target/etteum"
  chmod +x "$PROJECT_DIR/etteum"
  ok "Linked $target/etteum -> $PROJECT_DIR/etteum"

  case ":$PATH:" in
    *":$target:"*) ;;
    *)
      warn "$target is not on your PATH."
      info "Add this to your shell rc file (~/.bashrc, ~/.zshrc, ~/.config/fish/config.fish):"
      info "  export PATH=\"\$HOME/.local/bin:\$PATH\""
      ;;
  esac
}

run_preflight() {
  step "Running preflight check"
  if bun scripts/preflight.ts; then
    return 0
  else
    warn "Preflight reported issues — see above. The server may still start."
    info "Run \`etteum doctor\` for a detailed report."
    return 1
  fi
}

# ── Main ──────────────────────────────────────────────────────────────

main() {
  printf "\n${C_BOLD}${C_BLUE}Etteum Pool Installer${C_RESET}  ${C_DIM}(%s%s)${C_RESET}\n" "$OS" "${DISTRO_FAMILY:+/$DISTRO_FAMILY}"

  show_summary

  ensure_basics
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
  run_preflight || true

  printf "\n${C_GREEN}${C_BOLD}✓ Installation complete!${C_RESET}\n\n"
  printf "Etteum Pool is installed at: ${C_BOLD}%s${C_RESET}\n\n" "$PROJECT_DIR"

  cat <<EOF
${C_BOLD}Quick Start:${C_RESET}

  1. Start the server:
     ${C_CYAN}etteum start${C_RESET}
     ${C_DIM}(or: cd $PROJECT_DIR && ./etteum start)${C_RESET}

  2. Open the dashboard:
     ${C_CYAN}http://localhost:1931${C_RESET}

  3. Add accounts via the dashboard UI (or bring your own keys via BYOK)

${C_BOLD}Useful Commands:${C_RESET}

  etteum status     Check server status
  etteum logs       Tail server logs
  etteum stop       Stop the server
  etteum restart    Restart the server
  etteum doctor     Diagnose installation health
  etteum update     Pull latest, rebuild, restart
  etteum help       Full command reference

${C_BOLD}Files of interest:${C_RESET}

  $PROJECT_DIR/.env             Configuration (API_KEY, ports, encryption)
  $PROJECT_DIR/data/            SQLite database & uploads
  $PROJECT_DIR/.etteum.log      Server logs

${C_DIM}Tip: re-run this installer any time to pull updates and rebuild.${C_RESET}
${C_DIM}Tip: trouble? run \`etteum doctor\` to get a checklist of fixes.${C_RESET}
EOF
}

main "$@"
