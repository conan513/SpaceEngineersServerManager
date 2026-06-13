#!/bin/bash
# Download Space Engineers Workshop mods via SteamCMD
# Usage: download-mods.sh <mods_json_path>
# Mods are downloaded to the Steam workshop content folder and symlinked into the server files.

set -uo pipefail

info()    { echo -e "\e[34m[MODS]\e[0m $*"; }
warning() { echo -e "\e[33m[MODS]\e[0m $*"; }
error()   { echo -e "\e[31m[MODS]\e[0m $*"; }

SE_APP_ID=244850
MODS_JSON="${1:-}"
BASE_DIR="$HOME/.local/share/se-server-manager"
SERVER_FILES="${SERVER_FILES:-$BASE_DIR/server-files}"

# ── Locate SteamCMD ──────────────────────────────────────────────────────────
STEAMCMD=""
for candidate in steamcmd "$HOME/.steam/steamcmd/steamcmd.sh" "$HOME/steamcmd/steamcmd.sh" /usr/bin/steamcmd /usr/games/steamcmd; do
  if command -v "$candidate" &>/dev/null 2>&1 || [ -x "$candidate" ]; then
    STEAMCMD="$candidate"
    break
  fi
done

if [ -z "$STEAMCMD" ]; then
  warning "SteamCMD not found – skipping mod download."
  warning "Install SteamCMD: https://developer.valvesoftware.com/wiki/SteamCMD"
  exit 0
fi

# ── Read mod IDs ─────────────────────────────────────────────────────────────
if [ -z "$MODS_JSON" ] || [ ! -f "$MODS_JSON" ]; then
  info "No mods.json provided or file not found. Skipping."
  exit 0
fi

# Use python3 to parse JSON (available on Arch Linux by default)
MOD_IDS=()
while IFS= read -r mod_id; do
  [ -n "$mod_id" ] && MOD_IDS+=("$mod_id")
done < <(python3 -c "
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    for m in data:
        print(str(m.get('id', '')).strip())
except Exception as e:
    print('', file=sys.stderr)
" "$MODS_JSON" 2>/dev/null)

if [ ${#MOD_IDS[@]} -eq 0 ]; then
  info "No mods to download."
  exit 0
fi

info "Downloading ${#MOD_IDS[@]} mod(s) via SteamCMD (anonymous login)..."

# ── Build SteamCMD args ───────────────────────────────────────────────────────
STEAMCMD_ARGS=(+login anonymous)
for mod_id in "${MOD_IDS[@]}"; do
  info "  → Queuing mod: $mod_id"
  STEAMCMD_ARGS+=(+workshop_download_item "$SE_APP_ID" "$mod_id" validate)
done
STEAMCMD_ARGS+=(+quit)

# Run SteamCMD
"$STEAMCMD" "${STEAMCMD_ARGS[@]}"
STEAMCMD_EXIT=$?

if [ $STEAMCMD_EXIT -ne 0 ]; then
  warning "SteamCMD exited with code $STEAMCMD_EXIT (some mods may not have downloaded)"
fi

# ── Symlink mods into server files so SE can find them ───────────────────────
# SE server looks for mods relative to the DedicatedServer folder:
#   DedicatedServer64/../content/workshop/  OR
#   ~/.steam/steam/steamapps/workshop/content/244850/
#
# We create symlinks from Steam's download location into the server content folder.

STEAM_WORKSHOP="$HOME/.steam/steam/steamapps/workshop/content/$SE_APP_ID"
# Fallback paths
[ ! -d "$STEAM_WORKSHOP" ] && STEAM_WORKSHOP="$HOME/.local/share/Steam/steamapps/workshop/content/$SE_APP_ID"
[ ! -d "$STEAM_WORKSHOP" ] && STEAM_WORKSHOP="$HOME/Steam/steamapps/workshop/content/$SE_APP_ID"

if [ ! -d "$STEAM_WORKSHOP" ]; then
  warning "Steam workshop content directory not found. Mods may not be available to the server."
  exit 0
fi

# Server content workshop dir
SERVER_WORKSHOP="$SERVER_FILES/Content/Workshop/content/$SE_APP_ID"
mkdir -p "$SERVER_WORKSHOP"

LINKED=0
for mod_id in "${MOD_IDS[@]}"; do
  SRC="$STEAM_WORKSHOP/$mod_id"
  DST="$SERVER_WORKSHOP/$mod_id"
  if [ -d "$SRC" ]; then
    if [ ! -e "$DST" ]; then
      ln -sf "$SRC" "$DST"
      info "  ✓ Linked mod $mod_id into server content"
    else
      info "  ✓ Mod $mod_id already linked"
    fi
    LINKED=$((LINKED + 1))
  else
    warning "  ✗ Mod $mod_id not found at $SRC (download may have failed)"
  fi
done

info "Done. $LINKED/${#MOD_IDS[@]} mod(s) available to server."
