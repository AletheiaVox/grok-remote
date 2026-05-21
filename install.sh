#!/usr/bin/env bash
# grok-remote bootstrap
# Minimal bash: ensure Node.js >= 20 is available, then hand off everything
# to installer.ts which has the real animated experience.

set -e

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEED_NODE_MAJOR=20

C_DIM='\033[2m'
C_TEAL='\033[38;2;94;234;212m'
C_BAD='\033[38;2;255;123;114m'
C_RESET='\033[0m'

printf "${C_DIM}bootstrap${C_RESET}  checking for node >= %s ...\n" "$NEED_NODE_MAJOR"

install_node_via_brew() {
  if ! command -v brew >/dev/null 2>&1; then
    printf "${C_BAD}error${C_RESET} Homebrew is required to install Node.js automatically.\n"
    printf "       Install Homebrew from https://brew.sh and re-run this script,\n"
    printf "       or install Node.js >= %s manually.\n" "$NEED_NODE_MAJOR"
    exit 1
  fi
  printf "${C_DIM}bootstrap${C_RESET}  installing node via brew ...\n"
  brew install node
}

if ! command -v node >/dev/null 2>&1; then
  printf "${C_DIM}bootstrap${C_RESET}  node not found.\n"
  install_node_via_brew
fi

NODE_VERSION=$(node --version | sed 's/^v\([0-9]*\).*/\1/')
if [ "$NODE_VERSION" -lt "$NEED_NODE_MAJOR" ]; then
  printf "${C_DIM}bootstrap${C_RESET}  node %s < %s, upgrading ...\n" "$NODE_VERSION" "$NEED_NODE_MAJOR"
  install_node_via_brew
fi

printf "${C_TEAL}bootstrap${C_RESET}  node $(node --version) ready, handing off to installer.ts\n\n"

if [ ! -d "$HERE/node_modules/tsx" ]; then
  printf "${C_DIM}bootstrap${C_RESET}  installing dev dependencies (tsx, typescript) ...\n"
  (cd "$HERE" && npm install --no-audit --no-fund)
fi

exec node --import tsx "$HERE/installer.ts" "$@"
