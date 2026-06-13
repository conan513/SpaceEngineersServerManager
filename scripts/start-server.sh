#!/bin/bash
# Space Engineers Dedicated Server Launcher for Arch Linux
# Runs the server using Wine inside Xvfb (Virtual Framebuffer).

set -euo pipefail

info() { echo -e "\e[34m[INFO]\e[0m $*"; }
error() { echo -e "\e[31m[ERROR]\e[0m $*"; exit 1; }

# Default directory definitions
BASE_DIR="$HOME/.local/share/se-server-manager"
WINE_PREFIX="${WINEPREFIX:-$BASE_DIR/wineprefix}"
SERVER_FILES="${SERVER_FILES:-$BASE_DIR/server-files}"
SERVER_DATA="${SERVER_DATA:-$BASE_DIR/server-data}"

export WINEPREFIX="$WINE_PREFIX"
export WINEARCH="win64"
export WINEDEBUG="-all"

# Verify folders exist
if [ ! -d "$SERVER_FILES" ]; then
    error "Server files directory not found at $SERVER_FILES. Please run install.sh first."
fi
if [ ! -d "$WINE_PREFIX" ]; then
    error "Wine prefix not found at $WINE_PREFIX. Please run install.sh first."
fi

# Convert Linux data path to Windows/Wine path
# E.g., /home/user/path -> Z:\home\user\path
info "Resolving Wine data path..."
WINE_DATA_PATH=$(winepath -w "$SERVER_DATA")
info "Linux path: $SERVER_DATA"
info "Wine path: $WINE_DATA_PATH"

EXE_PATH="$SERVER_FILES/DedicatedServer64/SpaceEngineersDedicated.exe"
if [ ! -f "$EXE_PATH" ]; then
    error "SpaceEngineersDedicated.exe not found at $EXE_PATH"
fi

cd "$SERVER_FILES/DedicatedServer64"

info "Starting Space Engineers Dedicated Server inside xvfb-run..."
# We run inside xvfb-run to provide a virtual X server, which Wine/Direct3D components require
# -console runs it in console/headless mode
# -ignorelastsession prevents it from crashing/acting up if it had an unclean exit last time
exec xvfb-run -a wine SpaceEngineersDedicated.exe -console -ignorelastsession -path "$WINE_DATA_PATH"
