#!/usr/bin/env bash
# Copies waystation/ into dist/ without the files a player never needs: the design spec, the README,
# the local server, the screenshot tooling and the engineers' preview pages.
# Used by .github/workflows/pages.yml; on Cloudflare Pages set the build command to `bash scripts/dist.sh`
# and the output directory to `dist`.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist
rsync -a --exclude 'DESIGN.md' --exclude 'README.md' --exclude 'serve.js' --exclude 'tools/' --exclude 'play/dev/' waystation/ dist/
echo "dist/ assembled:" && find dist -type f | sort
