#!/usr/bin/env bash
set -euo pipefail

ST_PATH="${SILLY_TAVERN_HOME:-}"
CONFIG_PATH=""
PACKAGE_PATH=""
NON_INTERACTIVE=0
KEEP_BACKUP=0
RAW_BASE="https://raw.githubusercontent.com/jixiangruyi117/SillyTavern-SRL-Bridge/main/server-plugin"
CDN_BASE="https://cdn.jsdelivr.net/gh/jixiangruyi117/SillyTavern-SRL-Bridge@main/server-plugin"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path) ST_PATH="${2:-}"; shift 2 ;;
    --config) CONFIG_PATH="${2:-}"; shift 2 ;;
    --package) PACKAGE_PATH="${2:-}"; shift 2 ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
    --keep-backup) KEEP_BACKUP=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

is_st_root() { [[ -n "${1:-}" && -f "$1/server.js" ]]; }

detect_roots() {
  local candidate
  local -a direct=("$PWD" "$HOME/SillyTavern" "$HOME/sillytavern" "$HOME/storage/shared/SillyTavern")
  for candidate in "${direct[@]}"; do
    if is_st_root "$candidate"; then (cd "$candidate" && pwd -P); fi
  done
  find "$HOME" -maxdepth 4 -type f -name server.js -path '*SillyTavern*' -print 2>/dev/null |
    while IFS= read -r candidate; do dirname "$candidate"; done
}

if [[ -n "$ST_PATH" ]]; then
  is_st_root "$ST_PATH" || { echo "server.js was not found in: $ST_PATH" >&2; exit 1; }
else
  mapfile -t ROOTS < <(detect_roots | awk '!seen[$0]++')
  if [[ ${#ROOTS[@]} -eq 1 ]]; then
    ST_PATH="${ROOTS[0]}"
    echo "Detected SillyTavern: $ST_PATH"
  elif [[ ${#ROOTS[@]} -gt 1 && $NON_INTERACTIVE -eq 0 ]]; then
    echo 'Multiple SillyTavern installations were found:'
    for index in "${!ROOTS[@]}"; do echo "  [$((index + 1))] ${ROOTS[$index]}"; done
    read -r -p 'Enter a number, or paste another SillyTavern root path: ' choice
    if [[ "$choice" =~ ^[0-9]+$ && "$choice" -ge 1 && "$choice" -le ${#ROOTS[@]} ]]; then
      ST_PATH="${ROOTS[$((choice - 1))]}"
    else
      ST_PATH="$choice"
    fi
  elif [[ $NON_INTERACTIVE -eq 0 ]]; then
    read -r -p 'SillyTavern was not detected. Paste its root directory path: ' ST_PATH
  fi
fi
is_st_root "$ST_PATH" || { echo 'SillyTavern was not detected. Re-run with --path "/your/SillyTavern".' >&2; exit 1; }
ST_PATH="$(cd "$ST_PATH" && pwd -P)"

if [[ -z "$CONFIG_PATH" ]]; then CONFIG_PATH="$ST_PATH/config.yaml"; fi
[[ -f "$CONFIG_PATH" ]] || { echo 'config.yaml was not found. Start SillyTavern once, or pass --config.' >&2; exit 1; }
command -v node >/dev/null || { echo 'node is required by SillyTavern and this installer.' >&2; exit 1; }

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/srl-bridge-install.XXXXXX")"
BACKUP_PATH=""
INSTALL_DONE=0

cleanup() {
  local exit_code=$?
  if [[ $exit_code -ne 0 && -n "${BACKUP_PATH:-}" && -e "$BACKUP_PATH" ]]; then
    rm -rf "$TARGET_PATH"
    mv "$BACKUP_PATH" "$TARGET_PATH"
    echo "Install failed; the previous server plugin was restored to: $TARGET_PATH" >&2
  fi
  rm -rf "$TEMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

download_file() {
  local url="$1"
  local output="$2"
  if command -v curl >/dev/null; then
    curl -fsSL --retry 3 --retry-all-errors \
      -A 'SRL-Bridge-Termux-Installer/0.3.5' \
      "$url" -o "$output"
  elif command -v wget >/dev/null; then
    wget -q --tries=3 -O "$output" "$url"
  else
    echo 'curl or wget is required. In Termux run: pkg install curl' >&2
    return 1
  fi
}

EXTRACT_ROOT="$TEMP_ROOT/package"
mkdir -p "$EXTRACT_ROOT"
if [[ -z "$PACKAGE_PATH" ]]; then
  ENTRY_ROOT="$EXTRACT_ROOT/srl-bridge"
  mkdir -p "$ENTRY_ROOT"
  echo 'Downloading the two server-plugin files (no Release ZIP required)...'
  for name in index.mjs relay.js; do
    if ! download_file "$RAW_BASE/$name" "$ENTRY_ROOT/$name"; then
      echo "Raw GitHub download failed; trying the CDN mirror for $name..." >&2
      download_file "$CDN_BASE/$name" "$ENTRY_ROOT/$name" || {
        echo 'Download failed. Check the network, or use --package with an offline ZIP.' >&2
        exit 1
      }
    fi
  done
  ENTRY="$ENTRY_ROOT/index.mjs"
else
  [[ -f "$PACKAGE_PATH" ]] || { echo "Package not found: $PACKAGE_PATH" >&2; exit 1; }
  command -v unzip >/dev/null || {
    echo 'unzip is required for --package. In Termux run: pkg install unzip' >&2
    exit 1
  }
  unzip -q "$PACKAGE_PATH" -d "$EXTRACT_ROOT" || {
    echo 'unzip reported a path warning; checking the extracted files...' >&2
  }
  ENTRY="$(find "$EXTRACT_ROOT" -type f -path '*/srl-bridge/index.mjs' -print -quit)"
fi
[[ -n "$ENTRY" && -f "$(dirname "$ENTRY")/relay.js" ]] || { echo 'Invalid server plugin package.' >&2; exit 1; }
grep -q "id: 'srl-bridge'" "$ENTRY" || { echo 'Downloaded index.mjs is not the SRL server plugin.' >&2; exit 1; }
grep -q 'srl-tavern-bridge' "$(dirname "$ENTRY")/relay.js" || { echo 'Downloaded relay.js is invalid.' >&2; exit 1; }

PLUGINS_ROOT="$ST_PATH/plugins"
TARGET_PATH="$PLUGINS_ROOT/srl-bridge"
BACKUP_ROOT="$ST_PATH/.srl-bridge-backups"
mkdir -p "$PLUGINS_ROOT"
if [[ -e "$TARGET_PATH" ]]; then
  mkdir -p "$BACKUP_ROOT"
  BACKUP_PATH="$BACKUP_ROOT/srl-bridge-$(date +%Y%m%d-%H%M%S)"
  mv "$TARGET_PATH" "$BACKUP_PATH"
  echo "The previous server plugin was moved aside temporarily: $BACKUP_PATH"
fi
cp -R "$(dirname "$ENTRY")" "$TARGET_PATH"

node - "$CONFIG_PATH" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
let config = fs.readFileSync(file, 'utf8');
const pattern = /^(\s*)enableServerPlugins\s*:\s*(?:true|false)\s*$/m;
config = pattern.test(config)
  ? config.replace(pattern, '$1enableServerPlugins: true')
  : `${config.replace(/\s*$/, '')}\n\nenableServerPlugins: true\n`;
fs.writeFileSync(file, config);
NODE

INSTALL_DONE=1
if [[ -n "${BACKUP_PATH:-}" && -e "$BACKUP_PATH" ]]; then
  if [[ $KEEP_BACKUP -eq 1 ]]; then
    echo "The previous server plugin was kept as a backup: $BACKUP_PATH"
  else
    rm -rf "$BACKUP_PATH"
    echo 'The previous server plugin was removed after the new version was installed.'
  fi
fi

echo ''
echo 'SUCCESS: SRL server relay plugin has been installed.'
echo 'Note: this is a server plugin under SillyTavern/plugins, not the front-end extension shown in the extension download page.'
echo "SillyTavern root: $ST_PATH"
echo "Plugin directory: $TARGET_PATH"
echo "Config file: $CONFIG_PATH"
echo 'Next: fully stop and restart SillyTavern.'
echo 'Verify: the startup log should contain: [SRL Bridge] Short-lived device relay loaded'
echo 'If you do not see it, make sure the running SillyTavern uses the SillyTavern root printed above.'
