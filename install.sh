#!/usr/bin/env bash
# Installs (or updates) Muzan Interview Coder on macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/ivoreda/muzan-interview-coder/main/install.sh | bash
#
# Files downloaded with curl are not quarantined by macOS, so the app opens
# without the "unidentified developer" warning even though it is not notarized.

set -euo pipefail

REPO="ivoreda/muzan-interview-coder"
APP_NAME="Muzan Interview Coder"
INSTALL_DIR="/Applications"
TMP_DIR=""

main() {
    if [[ "$(uname -s)" != "Darwin" ]]; then
        echo "This installer is for macOS. On Windows, download muzan-interview-coder-windows-setup.exe from:"
        echo "  https://github.com/$REPO/releases/latest"
        exit 1
    fi

    # Pick the Apple Silicon build on M-series Macs, even if this shell runs under Rosetta.
    local arch="x64"
    if [[ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" == "1" ]]; then
        arch="arm64"
    fi

    local url="https://github.com/$REPO/releases/latest/download/muzan-interview-coder-mac-$arch.zip"
    TMP_DIR="$(mktemp -d)"
    trap 'rm -rf "$TMP_DIR"' EXIT
    local tmp="$TMP_DIR"

    echo "Downloading $APP_NAME ($arch)..."
    curl -fL --progress-bar "$url" -o "$tmp/app.zip"

    echo "Unpacking..."
    ditto -x -k "$tmp/app.zip" "$tmp/unpacked"
    if [[ ! -d "$tmp/unpacked/$APP_NAME.app" ]]; then
        echo "Error: the download did not contain $APP_NAME.app" >&2
        exit 1
    fi

    # Quit a running copy so it can be replaced.
    if pgrep -f "$INSTALL_DIR/$APP_NAME.app/Contents/MacOS/" >/dev/null 2>&1; then
        echo "Closing the running app..."
        osascript -e "quit app \"$APP_NAME\"" >/dev/null 2>&1 || true
        sleep 2
        pkill -f "$INSTALL_DIR/$APP_NAME.app/Contents/MacOS/" >/dev/null 2>&1 || true
    fi

    # /Applications is writable for admin users; otherwise ask for a password.
    local sudo=""
    if [[ ! -w "$INSTALL_DIR" ]]; then
        echo "Administrator password needed to install into $INSTALL_DIR."
        sudo="sudo"
    fi

    echo "Installing to $INSTALL_DIR..."
    $sudo rm -rf "$INSTALL_DIR/$APP_NAME.app"
    $sudo ditto "$tmp/unpacked/$APP_NAME.app" "$INSTALL_DIR/$APP_NAME.app"
    $sudo xattr -dr com.apple.quarantine "$INSTALL_DIR/$APP_NAME.app" 2>/dev/null || true

    echo
    echo "Installed $APP_NAME."
    echo "On first launch, allow Microphone, Screen Recording and Accessibility when macOS asks"
    echo "(System Settings > Privacy & Security). You may need to reopen the app after granting them."
    open "$INSTALL_DIR/$APP_NAME.app"
}

# Everything runs inside main so a partially downloaded script never executes.
main "$@"
