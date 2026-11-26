#!/usr/bin/env bash
# Uploads the installers in dist/ to a GitHub release named after package.json's version.
# Run `npm run dist` first (or use `npm run release`, which does both).
set -euo pipefail
cd "$(dirname "$0")/.."

version="v$(node -p "require('./package.json').version")"
files=(
    dist/muzan-interview-coder-mac-arm64.zip
    dist/muzan-interview-coder-mac-x64.zip
    dist/muzan-interview-coder-mac-arm64.dmg
    dist/muzan-interview-coder-mac-x64.dmg
    dist/muzan-interview-coder-windows-setup.exe
)
for f in "${files[@]}"; do
    [[ -f "$f" ]] || { echo "Missing $f — run npm run dist first." >&2; exit 1; }
done

if gh release view "$version" >/dev/null 2>&1; then
    echo "Release $version exists; replacing its files."
    gh release upload "$version" "${files[@]}" --clobber
else
    gh release create "$version" "${files[@]}" --title "$version" --notes "$(cat <<'EOF'
**macOS:** install with
```
curl -fsSL https://raw.githubusercontent.com/ivoreda/muzan-interview-coder/main/install.sh | bash
```
**Windows:** download `muzan-interview-coder-windows-setup.exe` and run it (SmartScreen: More info → Run anyway).
EOF
)"
fi
echo "Published $version."
