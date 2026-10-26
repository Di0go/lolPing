#!/bin/sh
# Builds everything the PKGBUILD packages, then the package: ./packaging/arch/build.sh
# Install the result with: sudo pacman -U packaging/arch/lolping-*.pkg.tar.zst
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
[ -d node_modules ] || { npm ci; npx install-electron; }
npm run build:helper
native/kwin-plugin/build.sh
npx electron-vite build
npx electron-builder --linux dir --publish never
cd packaging/arch
makepkg -f
