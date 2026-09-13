#!/usr/bin/env bash
#
# Everything, in one command.
#
#   ./verify.sh
#
# Typechecks, tests and lints both packages, builds the web app, then boots the
# backend on a throwaway database and drives the live check against it — the
# app's real modules, not stand-ins.
#
# The live checks are the part that cannot be skipped without losing the point.
# Several bugs in this repo passed every unit test and every typecheck because
# the tests injected a double that behaved better than the real client. Running
# the units without the live checks would restore exactly that blind spot.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# A port nothing else is on, and a database that exists only for this run.
PORT="${VERIFY_PORT:-3199}"
DB="$(mktemp -t meb-verify-XXXXXX).db"
SERVER_PID=""
FAILURES=()

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$DB"
}
trap cleanup EXIT

step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Runs a command in a package directory, records the failure, and keeps going —
# one broken package should not hide the state of the other.
#
# Deliberately NOT wrapped in a subshell. `FAILURES+=(...)` inside `( ... )`
# never reaches the parent, so the first version of this script printed
# "Everything passed" while a live check was failing. A verification harness
# that reports success on failure is worse than no harness at all.
run() {
  local dir="$1" name="$2"; shift 2
  local before="$PWD"

  cd "$ROOT/$dir"
  if "$@" > /tmp/verify-out.txt 2>&1; then
    printf '  ✓ %s\n' "$name"
  else
    printf '  ✗ %s\n' "$name"
    sed 's/^/      /' /tmp/verify-out.txt | tail -25
    FAILURES+=("$dir: $name")
  fi
  cd "$before"
}

step "backend"
run backend "typecheck" npm run typecheck
run backend "tests (sqlite)" npm test
# The same suite on a real Postgres engine in-process. Production is Postgres;
# a query that is right on SQLite and wrong there must fail here, not there.
run backend "tests (postgres)" npm run test:postgres

step "app"
run mobile "typecheck" npx tsc --noEmit
run mobile "tests" npm test
run mobile "lint" npx expo lint
# The installable build: the manifest, the worker and the icons must all come
# out, or what ships is a website rather than an app.
run mobile "web build" npx expo export --platform web
run mobile "web build carries the app shell" test -f dist/manifest.webmanifest -a -f dist/sw.js -a -f dist/icons/icon-512.png

step "firmware"
# The protocol, the handshake and the JBD codec on the host, against the
# same vectors the app asserts. Needs PlatformIO; without it the step is
# reported as skipped rather than silently passed.
if command -v pio > /dev/null 2>&1; then
  run firmware "protocol host tests" pio test -e native
else
  printf '  - firmware host tests skipped (pio not installed: pip install platformio)\n'
fi

step "live check — real client modules against a running API"

JWT_SECRET="a-verify-run-signing-secret-of-length" \
DATABASE_FILE="$DB" \
PORT="$PORT" \
COMPANY_NAME="Verify Run" \
BOOTSTRAP_ADMIN_EMAIL="ops@mebenergy.example" \
BOOTSTRAP_ADMIN_PASSWORD="a-verify-run-passphrase" \
  npx --prefix backend tsx backend/src/main.ts > /tmp/verify-server.log 2>&1 &
SERVER_PID=$!

# Wait for it rather than sleeping a guessed amount: a slow machine should not
# fail the run, and a fast one should not wait for nothing.
for _ in $(seq 1 60); do
  if curl -fsS -m 2 "http://localhost:$PORT/ready" > /dev/null 2>&1; then break; fi
  sleep 0.5
done

if ! curl -fsS -m 2 "http://localhost:$PORT/ready" > /dev/null 2>&1; then
  printf '  ✗ the backend did not become ready\n'
  tail -20 /tmp/verify-server.log | sed 's/^/      /'
  FAILURES+=("backend startup")
else
  export API="http://localhost:$PORT"
  export ADMIN_EMAIL="ops@mebenergy.example"
  export ADMIN_PASSWORD="a-verify-run-passphrase"

  run mobile "app modules against the live API" npm run live-check
fi

if [[ ${#FAILURES[@]} -eq 0 ]]; then
  printf '\n\033[32mEverything passed.\033[0m\n\n'
  exit 0
fi

printf '\n\033[31m%d failed:\033[0m %s\n\n' "${#FAILURES[@]}" "${FAILURES[*]}"
exit 1
