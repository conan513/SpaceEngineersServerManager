#!/bin/bash
# Space Engineers Dedicated Server Manager - Arch Linux Installation Script
# This script should be run as the local user (do NOT run as root).

set -euo pipefail

# Text formatting helper
info() { echo -e "\e[34m[INFO]\e[0m $*"; }
warn() { echo -e "\e[33m[WARNING]\e[0m $*"; }
error() { echo -e "\e[31m[ERROR]\e[0m $*"; echo "Aborting installation."; exit 1; }

info "Checking system requirements..."

# Required commands list
DEPENDENCIES=("wine" "winetricks" "xvfb-run" "node" "npm" "zip" "unzip" "cabextract")
MISSING_DEPS=()

for cmd in "${DEPENDENCIES[@]}"; do
    if ! command -v "$cmd" &> /dev/null; then
        MISSING_DEPS+=("$cmd")
    fi
done

# Check steamcmd separately, as it can be installed in user home too
STEAMCMD_CMD=""
if command -v steamcmd &> /dev/null; then
    STEAMCMD_CMD="steamcmd"
elif [ -f "$HOME/.local/share/steamcmd/steamcmd.sh" ]; then
    STEAMCMD_CMD="$HOME/.local/share/steamcmd/steamcmd.sh"
else
    MISSING_DEPS+=("steamcmd")
fi

if [ ${#MISSING_DEPS[@]} -gt 0 ]; then
    warn "The following required dependencies are missing:"
    for dep in "${MISSING_DEPS[@]}"; do
        echo "  - $dep"
    done
    echo ""
    info "To install them on Arch Linux, run the following command in terminal:"
    echo "  sudo pacman -S wine winetricks xorg-server-xvfb nodejs npm zip unzip cabextract"
    echo ""
    info "If steamcmd is missing, you can install it from AUR (e.g. using yay -S steamcmd) or install manually."
    error "Missing system dependencies."
fi

# Set up directory paths
BASE_DIR="$HOME/.local/share/se-server-manager"
WINE_PREFIX="$BASE_DIR/wineprefix"
SERVER_FILES="$BASE_DIR/server-files"
SERVER_DATA="$BASE_DIR/server-data"
BACKUPS_DIR="$BASE_DIR/backups"

info "Creating directories..."
mkdir -p "$BASE_DIR" "$WINE_PREFIX" "$SERVER_FILES" "$SERVER_DATA" "$BACKUPS_DIR"

# Configure Wine Prefix
info "Configuring Wine prefix at: $WINE_PREFIX..."
export WINEPREFIX="$WINE_PREFIX"
export WINEARCH="win64"
export WINEDEBUG="-all"

# Initialize wine prefix
if [ ! -d "$WINE_PREFIX/drive_c" ]; then
    info "Initializing empty Wineprefix..."
    wineboot --init
    sleep 5
fi

# Install dependencies inside wineprefix via winetricks (requires dotnet48 and vcrun2013/2017)
# Using xvfb-run to ensure installers that demand a display can run successfully
info "Installing .NET Framework 4.8 and VC++ Redistributables..."
info "This step might take 10-20 minutes and consumes CPU. Please be patient."

# Ensure xvfb-run is used to avoid interactive windows locking up the script
xvfb-run -a winetricks -q dotnet48 vcrun2013 vcrun2017

info "Dependencies successfully installed inside Wine!"

# Install/Update SEDS using SteamCMD
info "Downloading/Updating Space Engineers Dedicated Server files via SteamCMD..."
"$STEAMCMD_CMD" +login anonymous +force_install_dir "$SERVER_FILES" +app_update 298740 validate +quit

# Initialize default configuration files if they do not exist
info "Setting up default Space Engineers configuration..."
mkdir -p "$SERVER_DATA/Saves"

# Create a basic SpaceEngineers-Dedicated.cfg if it doesn't exist
DEFAULT_CFG="$SERVER_DATA/SpaceEngineers-Dedicated.cfg"
if [ ! -f "$DEFAULT_CFG" ]; then
    info "Creating default SpaceEngineers-Dedicated.cfg..."
    cat << 'EOF' > "$DEFAULT_CFG"
<?xml version="1.0" encoding="utf-8"?>
<MyConfigDedicated xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SessionSettings>
    <GameMode>Survival</GameMode>
    <InventorySizeMultiplier>10</InventorySizeMultiplier>
    <BlocksInventorySizeMultiplier>1</BlocksInventorySizeMultiplier>
    <AssemblerSpeedMultiplier>3</AssemblerSpeedMultiplier>
    <AssemblerEfficiencyMultiplier>3</AssemblerEfficiencyMultiplier>
    <RefinerySpeedMultiplier>3</RefinerySpeedMultiplier>
    <OnlineMode>PUBLIC</OnlineMode>
    <MaxPlayers>4</MaxPlayers>
    <MaxFloatingObjects>100</MaxFloatingObjects>
    <MaxBackupSaves>5</MaxBackupSaves>
    <MaxGridSize>0</MaxGridSize>
    <MapSizeUnused>0</MapSizeUnused>
    <NumericSecondsToSave>600</NumericSecondsToSave>
    <WelderSpeedMultiplier>2</WelderSpeedMultiplier>
    <GrinderSpeedMultiplier>2</GrinderSpeedMultiplier>
    <HackSpeedMultiplier>0.33</HackSpeedMultiplier>
    <AutoSaveInMinutes>5</AutoSaveInMinutes>
    <EnableSpectator>false</EnableSpectator>
    <EnableSpectatorFreeCamera>false</EnableSpectatorFreeCamera>
    <WorldSizeKm>0</WorldSizeKm>
    <RespawnShipDelayMultiplier>1</RespawnShipDelayMultiplier>
    <RealisticSound>false</RealisticSound>
    <SpawnShipTimeMultiplier>0.5</SpawnShipTimeMultiplier>
    <DestructibleBlocks>true</DestructibleBlocks>
    <EnableIngameScripts>true</EnableIngameScripts>
    <ViewDistance>15000</ViewDistance>
    <VoxelGeneratorVersion>4</VoxelGeneratorVersion>
    <EnableContainerDrop>true</EnableContainerDrop>
    <KeepBridgeStructure>true</KeepBridgeStructure>
    <EnableToolShake>true</EnableToolShake>
  </SessionSettings>
  <LoadWorld />
  <IP>0.0.0.0</IP>
  <Port>27016</Port>
  <ServerName>Arch Linux Space Engineers Server</ServerName>
  <WorldName>Default World</WorldName>
  <PauseGameWhenEmpty>true</PauseGameWhenEmpty>
  <IgnoreLastSession>false</IgnoreLastSession>
  <PremadeCheckpointPath>Content\CustomWorlds\Star System</PremadeCheckpointPath>
  <ServerAdminUUIDs />
  <Banned />
  <Mods />
  <SavedEcps />
</MyConfigDedicated>
EOF
fi

info "Installation completed successfully!"
info "You can now run 'npm install' in the project directory and start the server manager."
