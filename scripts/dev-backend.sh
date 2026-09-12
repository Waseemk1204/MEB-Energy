#!/usr/bin/env bash
# The API, for local development. Creates the company and its first
# administrator on an empty database; once anyone exists these do nothing.
#
# Override any of these in your shell before running.
set -euo pipefail
cd "$(dirname "$0")/../backend"

export JWT_SECRET="${JWT_SECRET:-a-local-development-signing-secret-only}"
export DATABASE_FILE="${DATABASE_FILE:-company.db}"
export COMPANY_NAME="${COMPANY_NAME:-MEB Energy}"
export BOOTSTRAP_ADMIN_EMAIL="${BOOTSTRAP_ADMIN_EMAIL:-admin@mebenergy.example}"
export BOOTSTRAP_ADMIN_PASSWORD="${BOOTSTRAP_ADMIN_PASSWORD:-change-this-password}"
# Metro's dev server, and the exported build's static server.
export CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:8081,http://localhost:4173}"
export PORT="${PORT:-3000}"

exec npx tsx watch src/main.ts
