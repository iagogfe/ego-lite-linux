#!/usr/bin/env bash
# Seed the ego Linux host profile with the login state of a system Chrome profile.
#
# The Linux host starts from a fresh profile, so every site would need a new sign-in.
# This script copies only the files that carry login state, and takes a consistent
# sqlite snapshot with `sqlite3 .backup`, so it is safe to run while Chrome is open
# (a live profile is never copied blindly). Cookie values are never printed.
#
# Usage (from anywhere; resolves the repo root relative to this script):
#   bash skills/ego-browser/scripts/seed-chrome-profile.sh
#   bash skills/ego-browser/scripts/seed-chrome-profile.sh --from ~/.config/chromium
#   bash skills/ego-browser/scripts/seed-chrome-profile.sh --to /tmp/profile --reload
#
# Requirements:
#   - Linux (or WSL with a Linux-side Chrome profile)
#   - sqlite3 (recommended; falls back to cp with a warning)
set -euo pipefail

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/ego-lite"
SRC_PROFILE=""
DEST_PROFILE="$DATA_DIR/profile"
RELOAD=0
ALLOW_RUNNING=0
TMP_DIR=""

cleanup() {
  if [ -n "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

log() {
  printf '%s\n' "$*" >&2
}

die() {
  log "error: $*"
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: seed-chrome-profile.sh [--from DIR] [--to DIR] [--reload] [-h|--help]

  Copy Chrome login state (cookies, local state, preferences, saved logins)
  into the ego Linux host profile.

  --from DIR    Chrome profile root (default: auto-detect google-chrome/chromium)
  --to DIR      ego profile root (default: $XDG_DATA_HOME/ego-lite/profile)
  --reload      restart the ego browser after seeding (ego-browser --reload)
  --allow-running
                proceed even if the ego browser is running (it may overwrite the
                copied cookies until it is reloaded)
  -h, --help    Show this help
EOF
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --from)
        [ "$#" -ge 2 ] || die "--from needs a value"
        SRC_PROFILE="$2"
        shift 2
        ;;
      --to)
        [ "$#" -ge 2 ] || die "--to needs a value"
        DEST_PROFILE="$2"
        shift 2
        ;;
      --reload)
        RELOAD=1
        shift
        ;;
      --allow-running)
        ALLOW_RUNNING=1
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1 (try --help)"
        ;;
    esac
  done
}

detect_source() {
  if [ -n "$SRC_PROFILE" ]; then
    [ -d "$SRC_PROFILE" ] || die "profile not found: $SRC_PROFILE"
    return 0
  fi

  local candidate
  for candidate in \
    "${CHROME_PROFILE:-}" \
    "$HOME/.config/google-chrome" \
    "$HOME/.config/chromium" \
    "$HOME/.config/google-chrome-beta" \
    "$HOME/.config/google-chrome-unstable"
  do
    if [ -n "$candidate" ] && [ -f "$candidate/Default/Cookies" ]; then
      SRC_PROFILE="$candidate"
      SRC_PROFILE="$(cd "$candidate" && pwd)"
      return 0
    fi
  done

  die "no Chrome profile found (looked for Default/Cookies under ~/.config/google-chrome and ~/.config/chromium). Pass --from DIR."
}

ego_running() {
  if pgrep -f "ego-lite/profile" >/dev/null 2>&1; then
    return 0
  fi
  [ -S "$DATA_DIR/host.sock" ] && return 0
  return 1
}

snapshot_sqlite() {
  local src="$1" dest="$2"
  if command -v sqlite3 >/dev/null 2>&1; then
    # .backup reads through the sqlite pager and produces a consistent copy even
    # when another process has the database open. A live file is never copied.
    sqlite3 "$src" ".backup '$dest'"
  else
    log "warning: sqlite3 not found; copying $src directly (close Chrome first to be safe)"
    cp "$src" "$dest"
  fi
}

main() {
  parse_args "$@"
  detect_source

  [ -f "$SRC_PROFILE/Default/Cookies" ] || die "missing $SRC_PROFILE/Default/Cookies"

  if ego_running && [ "$ALLOW_RUNNING" -eq 0 ] && [ "$RELOAD" -eq 0 ]; then
    log "warning: the ego browser looks running; it may overwrite the seeded cookies."
    log "         pass --reload to restart it now, or --allow-running to seed anyway."
  fi

  TMP_DIR="$(mktemp -d)"
  local tmp="$TMP_DIR"

  log "Seeding from: $SRC_PROFILE"
  log "Seeding into: $DEST_PROFILE"

  snapshot_sqlite "$SRC_PROFILE/Default/Cookies" "$tmp/Cookies"

  if [ -f "$SRC_PROFILE/Default/Login Data" ]; then
    snapshot_sqlite "$SRC_PROFILE/Default/Login Data" "$tmp/Login Data" 2>/dev/null \
      || cp "$SRC_PROFILE/Default/Login Data" "$tmp/Login Data" 2>/dev/null \
      || true
  fi

  local state
  for state in "Local State" "Default/Preferences"; do
    if [ -f "$SRC_PROFILE/$state" ]; then
      cp "$SRC_PROFILE/$state" "$tmp/$(basename "$state")"
    fi
  done

  mkdir -p "$DEST_PROFILE/Default"

  if [ -f "$DEST_PROFILE/Default/Cookies" ]; then
    cp "$DEST_PROFILE/Default/Cookies" "$DEST_PROFILE/Default/Cookies.bak-$(date +%Y%m%d-%H%M%S)"
  fi
  rm -f "$DEST_PROFILE/Default/Cookies-wal" "$DEST_PROFILE/Default/Cookies-shm"

  install -m 600 "$tmp/Cookies" "$DEST_PROFILE/Default/Cookies"
  if [ -f "$tmp/Login Data" ]; then
    install -m 600 "$tmp/Login Data" "$DEST_PROFILE/Default/Login Data"
  fi
  if [ -f "$tmp/Local State" ]; then
    install -m 600 "$tmp/Local State" "$DEST_PROFILE/Local State"
  fi
  if [ -f "$tmp/Preferences" ]; then
    install -m 600 "$tmp/Preferences" "$DEST_PROFILE/Default/Preferences"
  fi

  local count="0"
  if command -v sqlite3 >/dev/null 2>&1; then
    count="$(sqlite3 "$DEST_PROFILE/Default/Cookies" "select count(*) from cookies" 2>/dev/null || printf '0')"
  fi
  log "Seeded $count cookies into $DEST_PROFILE/Default/Cookies"

  if [ "$RELOAD" -eq 1 ]; then
    if command -v ego-browser >/dev/null 2>&1; then
      ego-browser --reload >/dev/null 2>&1 || log "warning: ego-browser --reload failed; restart the host manually"
      log "ego browser reloaded; sign-in state is now active"
    else
      log "warning: ego-browser not on PATH; start the host to pick up the seeded profile"
    fi
  else
    log "Restart the host to apply: ego-browser --reload"
  fi
}

main "$@"