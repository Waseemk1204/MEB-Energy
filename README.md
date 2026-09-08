# knowyourEV

BMS diagnostics, configuration and fleet management for EV battery packs.

Three codebases, one product:

| | What it is | Stack |
|---|---|---|
| [`mobile/`](mobile) | The technician's app — live instrumentation, on-site parameter writes over BLE | Expo SDK 57, React Native 0.86, expo-router |
| [`backend/`](backend) | The API — auth, tenancy, policy, the audit ledger, the command broker | Node 22, Fastify 5, `node:sqlite` |
| [`console/`](console) | The administration console — fleet, audit, remote support, users, devices, tenants | Vite, React 19 |

Design notes live in [`UI_PLAN.md`](UI_PLAN.md). **[`AS_BUILT.md`](AS_BUILT.md)
is the one to read before changing anything** — it records where the built
system diverges from the plan and, more usefully, the defects found along the
way and why each fix is shaped as it is.

---

## Running it

Node 22.13 or later. Each package installs independently.

### 1. The API

```bash
cd backend
npm install
JWT_SECRET="a-secret-of-your-own-at-least-32-chars" \
CORS_ORIGINS="http://localhost:5173" \
BOOTSTRAP_ADMIN_EMAIL="you@example.com" \
BOOTSTRAP_ADMIN_PASSWORD="a-password-of-at-least-12-chars" \
npm run dev
```

The bootstrap variables create the first administrator, and **only ever on a
database with no users at all** — once anyone exists they do nothing, so
setting them cannot mint an account on a running system.

### 2. The console

```bash
cd console
npm install
npm run dev
```

Sign in as the administrator you just bootstrapped. `VITE_API_URL` overrides
the API location; it defaults to `http://localhost:3000`.

### 3. The app

```bash
cd mobile
npm install
npx expo start
```

Scan the QR code with Expo Go. The API host is taken from the Expo dev server's
own address, so a phone on the same network finds it without editing anything.

---

## Access and limits

Payment happens outside knowyourEV. An administrator switches a company on for a
year from that moment, sets how many users it may have, and can change either
later without restarting the term. Sign-in checks the company as well as the
account, at login *and* at every token refresh — and answers **403, not 401**,
because the password was right and the person needs to ring their administrator,
not retype it.

Two limits are both about "devices", and they are deliberately never called the
same thing twice:

| | what it counts | default |
|---|---|---|
| **Gateways** (`device_limit`) | knowyourEV hardware the company may register | set per plan |
| **Sign-ins** (`session_device_limit`) | phones and browsers the **owner account** may be signed in on at once | 2 |

A third sign-in on the owner account signs out the device used longest ago and
tells the new one which — rather than refusing the newest. There is no email and
no self-service recovery here, so a refusal would strand an owner the day they
replace a phone; and an unexpected sign-out is the one signal that somebody else
has the password. The cap runs *after* the password is verified, so it can never
be used to sign somebody out by guessing at their email address.

Technicians are not capped this way — they hold their own seats, bounded by the
seat limit. A company can create a guest user to solve one problem and remove
them afterwards; removal deletes the account outright unless it has audit
history, in which case it is suspended instead, because an append-only trail
with a dangling actor is not a trail.

## Environment

### `backend/`

| Variable | Required | Default | Notes |
|---|---|---|---|
| `JWT_SECRET` | **yes** | — | The process refuses to start without it. A shared signing key across deployments is what PRD §8.1 forbids. |
| `CORS_ORIGINS` | for browsers | *(empty)* | Comma-separated allowlist. Empty serves **no** browser, including the console — the safe default, not an oversight. |
| `PORT` | no | `3000` | |
| `DATABASE_FILE` | no | `knowyourev.db` | `:memory:` for a throwaway instance. |
| `BOOTSTRAP_ADMIN_EMAIL` | first run | — | Only fires on an empty users table. |
| `BOOTSTRAP_ADMIN_PASSWORD` | first run | — | At least 12 characters. |
| `LOG_REQUESTS` | no | off | `1` to log every request. Unhandled errors are logged either way. |

### `console/`

| Variable | Default | Notes |
|---|---|---|
| `VITE_API_URL` | `http://localhost:3000` | Where the API lives. |

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

Typechecks, tests and lints all three packages, then boots the backend on a
throwaway database and drives both live checks against it. One command, and the
only one worth trusting before a change goes anywhere.

`.github/workflows/ci.yml` runs exactly that — one job, not three, because
splitting the packages into parallel jobs would leave the seams between them
unchecked, and the seams are where most of this project's real bugs have been.
*(This is not a git repository yet, so nothing runs it. It is ready for when
one exists.)*

The individual pieces, if you want them separately:

```bash
cd backend  && npm test          # node:test
cd mobile   && npm test          # jest-expo
cd console  && npm test          # vitest
```

Two of these reach across package boundaries on purpose, and skip cleanly when
the other package is not checked out beside them:

- `backend/src/policy/profileParity.test.ts` compares the backend's parameter
  seed with the app's bundled capability profile. The first time they were
  compared they disagreed on twelve fields.
- `console/src/theme/parity.test.ts` compares the console's palette with the
  app's tokens.

### Checking the seams for real

```bash
cd backend && npm run dev          # in one shell

cd mobile  && npm run live-check   # in another
cd console && npm run live-check
```

Both drive **the real client modules** against a running backend — the app's
API client, capability-profile reconciler, telemetry buffer, audit outbox,
presence and command code; the console's fleet, history, audit, admin and
support modules. Each run creates its own tenant, so repeating one cannot
collide with real data.

They exist because several bugs here survived thorough unit testing *and*
repeated live verification, all for the same reason: the live runs used `curl`
or an injected stand-in in place of the real client, and the stand-in did the
one thing the real client did not. **A double that behaves better than the
thing it replaces hides exactly the bug it was meant to find** — which is why
every one of the console's unit tests injects a `fetchImpl`, and why the
console could not make a single request in a browser while 71 of them passed.

### Checking the tests themselves

```bash
node mutants.mjs            # all 63 rules
node mutants.mjs mobile     # one package
node mutants.mjs "PIN"      # by name
```

Breaks each safety-critical rule in turn and checks something notices. **A rule
with no test that fails when it is removed is not a rule** — it is a comment
that happens to be executable.

Each entry says what it breaks and why that matters, so the file doubles as a
list of the properties this system is actually trying to hold: presence before
delivery, an append-only ledger nothing fabricated can reach, a 404 where a 403
would be an enumeration oracle, a chart that lifts the pen across a gap rather
than drawing through it.

It reports three outcomes, not two. A mutant whose anchor no longer matches is
**not** a caught mutant — it was never applied, and reporting it as a pass
would be the same false assurance the tool exists to find.

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
contract. `USE_MOCK` in `mobile/src/store/useTelemetryStore.ts` is the single
switch, and no screen changes when it flips.

**The app has not been run natively.** Everything has been exercised on the web
target, which runs the same JavaScript but does not prove native font loading,
native SVG rasterisation, or Reanimated on the UI thread.

**Invitations have no delivery.** An administrator hands the link over
themselves, and whoever holds an unused link can claim that account. Single use
and a seven-day expiry bound it; the console says so at the point of handover.
When email exists, only the delivery changes.

**SQLite is a development choice.** The schema is portable, but
`audit_events.seq` uses `MAX(seq) + 1`, which is not safe under concurrent
writers — on Postgres it should be `BIGSERIAL`. That comment is in
`backend/src/db/client.ts` next to the column.
