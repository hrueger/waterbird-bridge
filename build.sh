#!/usr/bin/env bash
set -euo pipefail

BINARY="dist/waterbird-bridge"

echo "── 1/5  bundling TypeScript…"
mkdir -p dist
npx esbuild src/visca-bridge.ts \
  --bundle \
  --platform=node \
  --format=cjs \
  --outfile=dist/bridge.cjs

echo "── 2/5  generating SEA blob…"
node --experimental-sea-config sea-config.json

echo "── 3/5  copying node binary…"
cp "$(which node)" "$BINARY"

echo "── 4/5  injecting blob…"
if [[ "$OSTYPE" == darwin* ]]; then
  codesign --remove-signature "$BINARY"
  npx postject "$BINARY" NODE_SEA_BLOB dist/sea-prep.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
    --macho-segment-name NODE_SEA
  echo "── 5/5  signing…"
  SIGN_ID="${APPLE_SIGNING_IDENTITY:--}"
  if [[ "$SIGN_ID" == "-" ]]; then
    codesign --sign - "$BINARY"
  else
    codesign --force --options runtime --sign "$SIGN_ID" "$BINARY"
  fi
else
  npx postject "$BINARY" NODE_SEA_BLOB dist/sea-prep.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
  echo "── 5/5  (signing skipped — not macOS)"
fi

echo ""
echo "✓  dist/waterbird-bridge  ($(du -sh "$BINARY" | cut -f1))"
