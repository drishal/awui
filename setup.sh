#!/usr/bin/env bash
# Build awui from this checkout and install it for this user.
#
#   ./setup.sh            ask, then build the binary, link ~/.local/bin/awui, and enable the user
#                         service (the desktop app only when you say so)
#   ./setup.sh --desktop  (re)install the desktop app, if the first run skipped it or it broke
#   ./setup.sh --update   git pull, rebuild (with the desktop app when this install has it), put the
#                         ~/.local/bin/awui link back in place, and restart the service when no chat is live
#
# Inside a checkout with devenv (NixOS), every build runs in `devenv shell`: its Node and its nixpkgs Bun
# are what make the compiled binary run there. Elsewhere it needs Node 22.19+, npm, and Bun 1.3.14+.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

LOCAL_BIN="$HOME/.local/bin"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/awui"

bold=$'\e[1m' dim=$'\e[2m' yellow=$'\e[33m' red=$'\e[31m' green=$'\e[32m' reset=$'\e[0m'
[ -t 1 ] || bold='' dim='' yellow='' red='' green='' reset=''
say() { printf '%s==>%s %s\n' "$bold" "$reset" "$*"; }
warn() { printf '%swarning:%s %s\n' "$yellow" "$reset" "$*" >&2; }
die() { printf '%serror:%s %s\n' "$red" "$reset" "$*" >&2; exit 1; }

# A yes/no question; $2 is the answer an empty reply means (y or n). Read from the terminal, so a pipe
# into the script cannot answer for you; without one, stdin is read (and EOF takes the default).
ask() {
  local prompt="$1" default="$2" hint reply
  hint=$([ "$default" = y ] && echo "[Y/n]" || echo "[y/N]")
  if [ -r /dev/tty ] && { : < /dev/tty; } 2>/dev/null; then
    read -r -p "$prompt $hint " reply < /dev/tty || reply=""
  else
    read -r reply || reply=""
  fi
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy] ]]
}

usage() {
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
}

# ---- the toolchain ----------------------------------------------------------------------

use_devenv() { command -v devenv >/dev/null 2>&1 && [ -f "$ROOT/devenv.nix" ] && [ -z "${DEVENV_ROOT:-}" ]; }

# Run one shell command line with the build toolchain: in devenv when this checkout has one.
in_toolchain() {
  if use_devenv; then devenv shell -- bash -c "$1"; else bash -c "$1"; fi
}

version_at_least() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

check_prereqs() {
  command -v git >/dev/null 2>&1 || die "git is not installed"
  if use_devenv; then
    say "Building inside devenv shell"
    return
  fi
  command -v node >/dev/null 2>&1 || die "Node 22.19+ is needed (https://nodejs.org)"
  command -v npm >/dev/null 2>&1 || die "npm is needed (it comes with Node)"
  command -v bun >/dev/null 2>&1 || die "Bun 1.3.14+ is needed for the build (curl -fsSL https://bun.sh/install | bash)"
  version_at_least "$(node -p 'process.versions.node')" 22.19.0 || die "Node $(node -p 'process.versions.node') is too old: 22.19+ is needed"
  version_at_least "$(bun --version)" 1.3.14 || die "Bun $(bun --version) is too old: 1.3.14+ is needed"
}

platform() {
  local os arch
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) die "setup.sh builds on Linux and macOS; on Windows see docs/install.md" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "unsupported CPU: $(uname -m)" ;;
  esac
  echo "$os-$arch"
}

BIN="$ROOT/dist/bin/$(platform)/awui"

# ---- the steps ----------------------------------------------------------------------------

# Dependencies and the binary in one toolchain session; with the desktop app, the binary carries it.
build() {
  local with_desktop="$1" target=build:binary
  [ "$with_desktop" = y ] && target=build:desktop
  say "Installing dependencies and building ($target)"
  mkdir -p "$LOCAL_BIN"
  in_toolchain "npm ci --no-audit --no-fund && npm run $target"
  [ -x "$BIN" ] || die "the build wrote no binary at $BIN"
}

# Whether the built binary carries the desktop app: its last ten bytes are the payload's magic.
carries_desktop() { [ -f "$BIN" ] && [ "$(tail -c 10 "$BIN" 2>/dev/null)" = "AWUIDESK01" ]; }

# ~/.local/bin/awui as a link to this checkout's binary. A copied binary (an older `install service`
# without --link) is kept as awui.bak, so a rebuild is what the link, and so the service, runs.
link_awui() {
  local link="$LOCAL_BIN/awui"
  mkdir -p "$LOCAL_BIN"
  if [ -L "$link" ] && [ "$(readlink -f "$link")" = "$(readlink -f "$BIN")" ]; then
    say "$link already links to $BIN"
    return
  fi
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    mv -f "$link" "$link.bak"
    warn "moved the copied $link aside to $link.bak"
  fi
  ln -sfn "$BIN" "$link"
  say "Linked $link → $BIN"
}

has_user_systemd() { command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; }

service_active() { has_user_systemd && systemctl --user is-active --quiet awui.service; }

# The user service, enabled and started, running the linked binary (so --update's rebuild is live after a restart).
install_service() {
  if ! has_user_systemd; then
    warn "no systemd user session here: start awui yourself (awui), or see docs/install.md for autostart"
    return
  fi
  say "Enabling the awui user service"
  "$BIN" install service --link
}

install_desktop() {
  say "Installing the desktop app"
  "$BIN" install desktop
  "$BIN" desktop --install-icon
}

# The port the running server published in the state folder; empty when it has published none.
server_port() {
  sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$STATE_DIR/server.json" 2>/dev/null | head -n1 || true
}

# How many chats the running server has live, from the port it published; empty when it cannot tell.
live_chats() {
  local port sessions
  port=$(server_port)
  port="${port:-4783}"
  sessions=$(curl -fsS --max-time 5 "http://127.0.0.1:$port/api/sessions" 2>/dev/null) || return 0
  # grep finds nothing when no chat is live, and exits 1: that is a count of 0, not a failure.
  { printf '%s' "$sessions" | grep -o '"liveChatId"' || true; } | wc -l | tr -d ' '
}

# Restarting stops every live chat's harness, so with chats live it asks first (and skips when it cannot ask).
restart_service() {
  service_active || return 0
  local live
  live=$(live_chats)
  if [ "${live:-0}" -gt 0 ] || [ -z "$live" ]; then
    local what="${live:+$live live chat(s)}"
    what="${what:-chats that may be live}"
    if ! [ -t 0 ] || ! ask "The awui service has $what; restarting stops them. Restart now?" n; then
      warn "service not restarted: run \`systemctl --user restart awui\` when your chats are done"
      return
    fi
  fi
  say "Restarting the awui service"
  systemctl --user restart awui.service
}

path_hint() {
  case ":$PATH:" in
    *":$LOCAL_BIN:"*) ;;
    *) warn "$LOCAL_BIN is not on your PATH: add it to your shell's profile to run awui by name" ;;
  esac
}

done_hint() {
  local port
  port=$(server_port)
  printf '\n%sawui is ready:%s http://127.0.0.1:%s  %s(awui doctor checks the harnesses)%s\n' "$green" "$reset" "${port:-4783}" "$dim" "$reset"
}

# ---- the modes ----------------------------------------------------------------------------

cmd_install() {
  local existing
  if existing=$(command -v awui 2>/dev/null); then
    warn "awui is already installed ($existing): run ./setup.sh --update to update it"
    if ! command -v awui-desktop >/dev/null 2>&1 && ask "The desktop app is not installed. Install it?" n; then
      cmd_desktop
    fi
    exit 0
  fi
  ask "Install awui (build it from this checkout, link ~/.local/bin/awui, and run it as a user service)?" y || exit 0
  local desktop=n
  ask "Also install the desktop app (Electron, about 160 MB more)?" n && desktop=y
  check_prereqs
  build "$desktop"
  link_awui
  install_service
  [ "$desktop" = y ] && install_desktop
  path_hint
  done_hint
}

cmd_desktop() {
  check_prereqs
  build y
  link_awui
  install_desktop
  # The binary the service runs now carries the app: a restart runs it (asked first when chats are live).
  restart_service
  path_hint
}

cmd_update() {
  check_prereqs
  [ -d "$ROOT/.git" ] || die "$ROOT is not a git checkout"
  say "Pulling the latest changes"
  git -C "$ROOT" pull --ff-only
  local desktop=n
  if carries_desktop || command -v awui-desktop >/dev/null 2>&1; then desktop=y; fi
  build "$desktop"
  link_awui
  [ "$desktop" = y ] && install_desktop
  restart_service
  path_hint
  say "Updated to $(git -C "$ROOT" log -1 --format='%h %s')"
}

case "${1:-}" in
  "") cmd_install ;;
  --desktop) cmd_desktop ;;
  --update) cmd_update ;;
  -h | --help) usage ;;
  *)
    usage >&2
    exit 2
    ;;
esac
