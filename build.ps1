# Windows local build — produces dist\waterbird-bridge.exe
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Binary = "dist\waterbird-bridge.exe"

Write-Host "── 1/4  Bundling TypeScript…"
New-Item -ItemType Directory -Force dist | Out-Null
npx esbuild src/visca-bridge.ts --bundle --platform=node --format=cjs --outfile=dist/bridge.cjs

Write-Host "── 2/4  Generating SEA blob…"
node --experimental-sea-config sea-config.json

Write-Host "── 3/4  Copying node binary…"
$NodePath = (Get-Command node).Source
Copy-Item $NodePath $Binary -Force

Write-Host "── 4/4  Injecting blob…"
npx postject $Binary NODE_SEA_BLOB dist\sea-prep.blob `
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

$Size = (Get-Item $Binary).Length / 1MB
Write-Host ""
Write-Host ("✓  {0}  ({1:F0} MB)" -f $Binary, $Size)
