#!/usr/bin/env bash
set -euo pipefail

BUMP=${1:-patch}

case "$BUMP" in
  major|minor|patch) ;;
  *) echo "Usage: $0 [major|minor|patch]  (default: patch)"; exit 1 ;;
esac

# Ensure working tree is clean
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: uncommitted changes — commit or stash them first"
  exit 1
fi

# npm version bumps package.json + package-lock.json without creating a git tag
npm version "$BUMP" --no-git-tag-version

NEW=$(node -p "require('./package.json').version")
TAG="v$NEW"

git add package.json package-lock.json
git commit -m "chore: bump version to $NEW"
git tag "$TAG"

echo "Pushing branch and tag $TAG…"
git push
git push origin "$TAG"

echo "✓  Released $TAG — GitHub Actions will build the binaries and publish the release."
