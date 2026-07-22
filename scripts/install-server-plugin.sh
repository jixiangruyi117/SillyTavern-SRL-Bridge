#!/usr/bin/env bash
set -euo pipefail

ST_PATH="${SILLY_TAVERN_HOME:-}"
CONFIG_PATH=""
PACKAGE_PATH=""
NON_INTERACTIVE=0
DOWNLOAD_URL="https://github.com/jixiangruyi117/SillyTavern-SRL-Bridge/releases/latest/download/srl-bridge-server-plugin-latest.zip"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path) ST_PATH="${2:-}"; shift 2 ;;
    --config) CONFIG_PATH="${2:-}"; shift 2 ;;
    --package) PACKAGE_PATH="${2:-}"; shift 2 ;;
    --non-interactive) NON_INTERACTIVE=1; shift ;;
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
command -v unzip >/dev/null || { echo 'unzip is required. In Termux run: pkg install unzip' >&2; exit 1; }
command -v node >/dev/null || { echo 'node is required by SillyTavern and this installer.' >&2; exit 1; }

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/srl-bridge-install.XXXXXX")"
trap 'rm -rf "$TEMP_ROOT"' EXIT

if [[ -z "$PACKAGE_PATH" ]]; then
  PACKAGE_PATH="$TEMP_ROOT/srl-bridge-server-plugin-latest.zip"
  echo 'Downloading the latest SRL Bridge server plugin...'
  if command -v curl >/dev/null; then
    curl -fL --retry 3 "$DOWNLOAD_URL" -o "$PACKAGE_PATH"
  elif command -v wget >/dev/null; then
    wget -O "$PACKAGE_PATH" "$DOWNLOAD_URL"
  else
    echo 'curl or wget is required. In Termux run: pkg install curl' >&2
    exit 1
  fi
fi
[[ -f "$PACKAGE_PATH" ]] || { echo "Package not found: $PACKAGE_PATH" >&2; exit 1; }

EXTRACT_ROOT="$TEMP_ROOT/package"
mkdir -p "$EXTRACT_ROOT"
unzip -q "$PACKAGE_PATH" -d "$EXTRACT_ROOT"
ENTRY="$(find "$EXTRACT_ROOT" -type f -path '*/srl-bridge/index.mjs' -print -quit)"
[[ -n "$ENTRY" && -f "$(dirname "$ENTRY")/relay.js" ]] || { echo 'Invalid server plugin package.' >&2; exit 1; }

PLUGINS_ROOT="$ST_PATH/plugins"
TARGET_PATH="$PLUGINS_ROOT/srl-bridge"
BACKUP_ROOT="$ST_PATH/.srl-bridge-backups"
mkdir -p "$PLUGINS_ROOT"
if [[ -e "$TARGET_PATH" ]]; then
  mkdir -p "$BACKUP_ROOT"
  BACKUP_PATH="$BACKUP_ROOT/srl-bridge-$(date +%Y%m%d-%H%M%S)"
  mv "$TARGET_PATH" "$BACKUP_PATH"
  echo "The previous server plugin was backed up to: $BACKUP_PATH"
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

echo 'SRL device relay server plugin installed.'
echo "SillyTavern root: $ST_PATH"
echo "Plugin directory: $TARGET_PATH"
echo "Config file: $CONFIG_PATH"
echo 'Fully restart SillyTavern. The startup log should contain: [SRL Bridge] Short-lived device relay loaded'
