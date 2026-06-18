#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="dist/waterbird-bridge"

echo "── 1/4  bundling TypeScript…"
mkdir -p dist
npx esbuild src/visca-bridge.ts \
  --bundle \
  --platform=node \
  --format=cjs \
  --outfile=dist/bridge.cjs

echo "── 2/4  generating SEA blob…"
node --experimental-sea-config sea-config.json

echo "── 3/4  copying node binary…"
cp "$(which node)" "$BINARY"

echo "── 4/4  injecting blob…"
if [[ "$OSTYPE" == darwin* ]]; then
  codesign --remove-signature "$BINARY"
  npx postject "$BINARY" NODE_SEA_BLOB dist/sea-prep.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
    --macho-segment-name NODE_SEA

  VERSION=$(node -p "require('$SCRIPT_DIR/package.json').version")
  APP_DIR="dist/Waterbird Bridge.app"

  echo "── 5/6  building .app bundle…"
  rm -rf "$APP_DIR"
  mkdir -p "$APP_DIR/Contents/MacOS"
  cp "$BINARY" "$APP_DIR/Contents/MacOS/waterbird-bridge"
  sed "s/VERSION_PLACEHOLDER/$VERSION/g" \
    "$SCRIPT_DIR/macos/Info.plist" > "$APP_DIR/Contents/Info.plist"

  echo "── 6/6  signing & creating DMG…"
  SIGN_ID="${APPLE_SIGNING_IDENTITY:--}"
  if [[ "$SIGN_ID" == "-" ]]; then
    codesign --force --deep --sign - "$APP_DIR"
  else
    codesign --force --deep --options runtime \
      --sign "$SIGN_ID" \
      --entitlements "$SCRIPT_DIR/macos/entitlements.plist" \
      "$APP_DIR"
  fi

  rm -rf dist/dmg_staging
  mkdir -p dist/dmg_staging
  cp -R "$APP_DIR" dist/dmg_staging/
  ln -sf /Applications dist/dmg_staging/Applications
  hdiutil create \
    -volname "Waterbird Bridge" \
    -srcfolder dist/dmg_staging \
    -ov -format UDZO \
    -o dist/waterbird-bridge.dmg
  rm -rf dist/dmg_staging

  if [[ "$SIGN_ID" != "-" ]]; then
    codesign --sign "$SIGN_ID" dist/waterbird-bridge.dmg
  fi

  echo ""
  echo "✓  dist/waterbird-bridge.dmg  ($(du -sh dist/waterbird-bridge.dmg | cut -f1))"
else
  npx postject "$BINARY" NODE_SEA_BLOB dist/sea-prep.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
  echo "── 5/5  (no .app — not macOS)"
  echo ""
  echo "✓  dist/waterbird-bridge  ($(du -sh "$BINARY" | cut -f1))"
fi
