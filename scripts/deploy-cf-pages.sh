#!/usr/bin/env bash
# Build the feed and publish dist/ to Cloudflare Pages project "games-omgithub-feed"
# by direct upload (no GitHub Actions, no Git-connected Pages project).
#
# Needs a Cloudflare API token with "Cloudflare Pages: Edit" on the account:
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=8ddf7f7a810ebcb02ffa7a039d6392ae scripts/deploy-cf-pages.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT="${CF_PAGES_PROJECT:-games-omgithub-feed}"

npm ci
# public/games.json is a local-only offline copy (gitignored); keep it out of the build.
if [ -f public/games.json ]; then mv public/games.json /tmp/feed-games.json.bak; trap 'mv /tmp/feed-games.json.bak public/games.json' EXIT; fi
npm run build
cp dist/index.html dist/404.html          # unknown paths: feed shell with HTTP 404
printf '/stats /stats/ 301\n' > dist/_redirects
cat > dist/_headers <<'H'
/*
  Cache-Control: no-cache, must-revalidate
  Expires: 0

/assets/*
  ! Cache-Control
  ! Expires
  Cache-Control: public, max-age=31536000, immutable
H

npx --yes wrangler@4 pages deploy dist --project-name "$PROJECT" --branch main --commit-dirty=true
