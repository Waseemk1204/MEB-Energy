# MEB Energy

BMS diagnostics, configuration and fleet management for the company's EV
battery packs — shipped as an installable web app.

Two codebases, one product:

| | What it is | Stack |
|---|---|---|
| [`mobile/`](mobile) | The app. Technicians connect to packs over BLE; administrators look after people, fleet, gateways, the ledger and remote support. Built for the web as a PWA; iOS and Android build from the same source. | Expo SDK 57, React Native 0.86, expo-router |
| [`backend/`](backend) | The API — auth, the company, policy, the audit ledger, the command broker | Node 22, Fastify 5, `node:sqlite` |

This is a standalone company application. It began life as a multi-tenant
platform with a separate administration console; that layer — platform
administrators, tenant management, plans, seat and gateway caps, the console
itself — is gone. The company is the organisation, and its own administrator
is the top of the hierarchy. **[`AS_BUILT.md`](AS_BUILT.md)** records how the
system was built and where it diverged from the plan; its first section
describes this restructure.

---

## Running it

Node 22.13 or later. Each package installs independently.

### 1. The API

```bash
cd backend
npm install
JWT_SECRET="a-secret-of-your-own-at-least-32-chars" \
CORS_ORIGINS="http://localhost:8081,http://localhost:4173" \
COMPANY_NAME="MEB Energy" \
BOOTSTRAP_ADMIN_EMAIL="you@example.com" \
BOOTSTRAP_ADMIN_PASSWORD="a-password-of-at-least-12-chars" \
npm run dev
```

The bootstrap variables create the company and its first administrator, and
**only ever on a database with no users at all** — once anyone exists they do
nothing, so setting them cannot mint an account on a running system.

[`scripts/dev-backend.sh`](scripts/dev-backend.sh) does the above with
development defaults.

### 2. The app

```bash
cd mobile
npm install
npm run web                 # Metro, in the browser, at :8081
```

Sign in as the administrator you just bootstrapped. The API host is taken from
the dev server's own address, so a phone on the same network finds it without
editing anything; `EXPO_PUBLIC_API_URL` overrides it.

### 3. The installable build

```bash
cd mobile
npm run build:web           # → dist/
npm run serve:web           # http://localhost:4173, with the single-page fallback
```

`dist/` is a static site: `index.html`, the bundle, `manifest.webmanifest`,
`sw.js` and the icons. Any static host serves it, with one requirement — every
path that is not a file must return `index.html` (the router owns the paths,
and an invitation link is a deep one). Netlify: `/* /index.html 200` in
`_redirects`. Vercel: a rewrite to `/index.html`. nginx: `try_files $uri
/index.html`. Set `EXPO_PUBLIC_API_URL` at build time to where the API lives,
and put the app's origin in the API's `CORS_ORIGINS`.

Opened in a browser, the app offers **Install** from Company settings (or
Settings on a connected pack) where the browser supports it, and explains
Share → Add to Home Screen on iOS. Installed, it opens standalone, and opens
with no signal: the service worker keeps the shell, and the telemetry buffer
and audit outbox already hold what is safe to hold until there is one.

---

## Who can do what

Two roles, both inside the company.

| Role | Who | What they may do |
|---|---|---|
| **Administrator** (`company`) | The company's owner, and whoever they make an administrator | Everything: people, packs, gateways, the ledger, remote support, and every parameter. Holds every permission implicitly. |
| **Technician** (`user`) | Field staff | Connects to packs on site. Read, write, location and health are each granted or not by an administrator, per person. |

People are invited, never created with a password: the administrator hands
over a single-use link (shared on a phone, copied on a desktop), the new person
sets their own first password, and nobody else ever sees it. Removal deletes an
account outright unless it has audit history, in which case it is suspended
instead — an append-only trail with a dangling actor is not a trail. The last
active administrator cannot be suspended.

There are no limits on how many people, packs or gateways the company has, and
no cap on how many devices anybody is signed in on.

## Environment

### `backend/`

| Variable | Required | Default | Notes |
|---|---|---|---|
| `JWT_SECRET` | **yes** | — | The process refuses to start without it. |
| `CORS_ORIGINS` | for browsers | *(empty)* | Comma-separated allowlist of the app's origins. Empty serves **no** browser — the safe default, not an oversight. |
| `PORT` | no | `3000` | |
| `DATABASE_FILE` | no | `company.db` | `:memory:` for a throwaway instance. |
| `COMPANY_NAME` | first run | `MEB Energy` | The company's name; an administrator can rename it later. |
| `BOOTSTRAP_ADMIN_EMAIL` | first run | — | Only fires on an empty users table. |
| `BOOTSTRAP_ADMIN_PASSWORD` | first run | — | At least 12 characters. |
| `LOG_REQUESTS` | no | off | `1` to log every request. Unhandled errors are logged either way. |

### `mobile/`

| Variable | Default | Notes |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | Metro host on :3000 / `http://localhost:3000` | Where the API lives. Read at build time. |

The app's name, icons, scheme and colours live in
[`mobile/app.json`](mobile/app.json) and
[`mobile/public/manifest.webmanifest`](mobile/public/manifest.webmanifest);
rebranding is a config change.

---

## Health and readiness

Two endpoints, and the difference matters to an orchestrator:

- **`GET /health`** — liveness. Answers without touching the database, because
  restarting a process is the wrong response to an unreachable database.
- **`GET /ready`** — readiness. Runs a real query. Returns 503 when the
  database is not answering or the parameter definitions are missing, so a
  broken instance is drained rather than left in the rotation.

---

## Verifying it

```bash
./verify.sh
```

Typechecks, tests and lints both packages, exports the web build and checks
the app shell came out of it, then boots the backend on a throwaway database
and drives the live check against it. One command, and the only one worth
trusting before a change goes anywhere.

The individual pieces:

```bash
cd backend  && npm test          # node:test
cd mobile   && npm test          # jest-expo
```

`backend/src/policy/profileParity.test.ts` reaches across the package boundary
on purpose: it compares the backend's parameter seed with the app's bundled
capability profile, and skips cleanly when the other package is not checked
out beside it.

### Checking the seams for real

```bash
cd backend && npm run dev          # in one shell
cd mobile  && npm run live-check   # in another
```

This drives **the real client modules** against a running backend — sign-in,
invitation, the company, fleet and gateway modules, the capability-profile
reconciler, telemetry buffer, audit outbox, presence, remote support and the
command claim. Everything it creates carries a per-run stamp, so repeating it
cannot collide with real data.

It exists because several bugs here survived thorough unit testing *and*
repeated live verification, all for the same reason: the live runs used `curl`
or an injected stand-in in place of the real client, and the stand-in did the
one thing the real client did not. **A double that behaves better than the
thing it replaces hides exactly the bug it was meant to find.** The DELETE
preflight is the latest example: retiring a pack worked from Node and failed in
every browser until the CORS allowlist named the verb.

### Checking the tests themselves

```bash
node mutants.mjs            # all 78 rules
node mutants.mjs mobile     # one package
node mutants.mjs "PIN"      # by name
```

Breaks each safety-critical rule in turn and checks something notices. **A rule
with no test that fails when it is removed is not a rule** — it is a comment
that happens to be executable.

---

## What is not finished

**Simulated readings never leave the phone.** `USE_MOCK` is on, so telemetry is
fabricated — and `TelemetrySource.simulated` says so, with `UploadBuffer`
refusing anything that admits to it. A mock session drives every screen and
uploads nothing. When `BleSource` lands it declares itself real and the uploads
start working, with no other change.

**The device path does not exist.** `backend/src/main.ts` wires a dispatcher
that throws by design, and `mobile/src/telemetry/BleSource.ts` does the same.
Commands are queued, policy is evaluated and the audit trail is written — the
last two hops (app → BLE → gateway → UART → BMS) need the firmware telemetry
contract. Note that a browser has no BLE; the on-site path is the phone build.

**Invitations have no delivery.** An administrator hands the link over
themselves, and whoever holds an unused link can claim that account. Single use
and a seven-day expiry bound it; the app says so at the point of handover.
When email exists, only the delivery changes.

**SQLite is a development choice.** The schema is portable, but
`audit_events.seq` uses `MAX(seq) + 1`, which is not safe under concurrent
writers — on Postgres it should be `BIGSERIAL`. That comment is in
`backend/src/db/client.ts` next to the column.
