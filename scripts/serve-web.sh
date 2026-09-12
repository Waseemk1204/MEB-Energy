#!/usr/bin/env bash
# Build the web app and serve it as a static host would, with the single-page
# fallback the router needs. http://localhost:4173
set -euo pipefail
cd "$(dirname "$0")/../mobile"
npm run build:web
exec node scripts/serveWeb.mjs
