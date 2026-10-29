#!/usr/bin/env bash
# Copies waystation/ into dist/ without the files a player never needs: the design spec, the README,
# the local server, the screenshot tooling and the engineers' preview pages.
# Used by .github/workflows/pages.yml; on Cloudflare Pages set the build command to `bash scripts/dist.sh`
# and the output directory to `dist`.
# No CNAME file is written: GitHub ignores one in an Actions deploy, and portsolace.com is set in Settings > Pages.
# Deploy order: the game calls https://{account,push,store}.portsolace.com, which exist only once each Worker is
# deployed with its routes line. Run `npx wrangler deploy` in workers/account, workers/push and workers/store, check
# that each /health on those hosts answers 200, and only then push the site (README.md, Domains).
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist
rsync -a --exclude '*.md' --exclude 'serve.js' --exclude 'tools/' --exclude 'play/dev/' waystation/ dist/
echo "dist/ assembled:" && find dist -type f | sort
