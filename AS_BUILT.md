# As-built delta

[`UI_PLAN.md`](UI_PLAN.md) and [`FRONTEND_PROMPT.md`](FRONTEND_PROMPT.md) were
written before the app existed. This records where the built app in
[`mobile/`](mobile/) diverges from them, and why — so the specs stay usable
rather than quietly wrong.

Everything not listed here was built as specified.

---

## 0. From platform to company (September 2026)

The system below was built as **KnowyourEV**: a multi-tenant platform with a
tenantless platform administrator, plans and entitlements per company, seat
and gateway and sign-in caps, and a separate Vite administration console. It
is now **MEB Energy's own application**, and that layer is gone. Everything
in the sections that follow that mentions a platform administrator, a tenant
list, an entitlement, a cap or the console describes the system as it was;
this section says what replaced it.

### What was removed

| Was | Now |
|---|---|
| Roles `admin` (platform-wide, no company) / `company` / `user` | Roles `company` (the company's administrator) / `user` (technician). `admin` is refused at the schema, the token and the login; a legacy row is suspended on startup. |
| `subscriptions` table, `entitlementOf` at every login and refresh, grant / revoke / limits routes, 403 refusals for lapsed plans | Gone. The company works. |
| Seat, battery and gateway limits; the owner's two-device sign-in cap and the "signed out elsewhere" notice | Gone. No count is a gate. |
| `/companies`, `/platform/overview`, `/companies/:id/*` | `GET /company` (name + server-counted overview), `PATCH /company` (rename). |
| `POST /users` taking a `companyId` and any role | Takes `role: 'company' \| 'user'` and optional permissions; the company is the caller's own, and a body naming another is 404. |
| `console/` (React + Vite) with Batteries, Battery, Audit, Support, Users, Devices, Companies, AcceptInvite | Deleted. Its operational pages that the app lacked were rebuilt inside the app: `accept-invite`, `company/gateways`, `company/ledger`, `company/support`, `company/settings`; `users/[id]` gained editing. |
| `.github/workflows/ci.yml` | Deleted with the platform repository. `./verify.sh` is the whole check; it runs the same steps locally. |

### What the company administrator inherited

The `company` role took over everything the platform administrator held that
is part of running a fleet: opening remote-support sessions and issuing
commands, Force Push, `requires_admin` parameters, and every permission
implicitly. `permissionsOf` returns the full set for them without reading the
columns, and `PATCH /users/:id/permissions` refuses to write those columns for
an administrator — otherwise a screen would say one thing and the server do
another. Where the policy engine said `role !== 'admin'` it now says `role !==
'company'`; the audit sources `admin_remote` / `admin_force_push` kept their
names because the ledger's CHECK constraint holds them and they still mean
"remote, by an administrator".

An administrator can also stand at a pack like anyone else: the "administrators
do not hold BLE sessions" refusal is gone. A write from them through the direct
route is still recorded as remote and still needs somebody's live session,
because the on-site path is the app's own BLE write, which files itself as
`local` through the audit upload.

### Tenancy stayed

Every operational table still carries `company_id` and every read still goes
through `tenantQuery`, which now has no unscoped branch at all. One company is
one tenant; the clause costs nothing and is what stops a stray row from a
merged database or a bug from appearing in the wrong list. `assertOwned` and
`canManageUsers` lost their admin escape and nothing else.

### The app as a PWA

`web.output` is `single`: one `index.html`, the router owns every path, and a
static host must fall back to it (the README says how per host;
`mobile/scripts/serveWeb.mjs` does it locally). `public/` carries
`index.html` (the shell, with the manifest link and Apple tags),
`manifest.webmanifest`, `sw.js` and the icons; Expo copies it into `dist/`.
The worker caches the app's own origin only — hashed bundles and fonts
forever, the page network-first — and never touches the API, whose readings
must not be served stale. It registers only in a production build, since
Metro serves a fresh bundle on every edit. `src/pwa/install.ts` holds
`beforeinstallprompt` so Settings can offer Install; on iOS it explains the
Share route instead, which is the only honest thing to say there.

Two things the browser target exposed that the phone never had:

· **`Alert.alert` is a no-op on react-native-web.** Retire, revoke and remove
  were each guarded by it, so in a browser they silently did nothing.
  `src/ui/confirm.ts` asks with the browser's own dialog on the web.
· **The CORS allowlist had no `DELETE`.** Retiring a pack and removing a
  person failed at the preflight in every browser while the Node live check,
  which sends no preflight, passed. The comment in `http/cors.ts` that said
  "the API has no DELETE" was written before the routes existed.

Invitation links are `https://<origin>/accept-invite?token=…` on the web and
`mebenergy://accept-invite?token=…` on a phone. Before this there was no
`accept-invite` screen in the app at all: the share sheet handed out a scheme
URL that nothing answered, and only the console could accept one.

The brand is `expo.name` in `app.json`, read through `src/brand.ts`; the
signed-in header shows the company's own name from the server, which an
administrator can change from Company settings. The icons are generated
(olive tile, battery glyph, wordmark) and replace the Expo template placeholder
that shipped before.

### Numbers

Backend 542 tests (was 645: the entitlement, session-cap and overview suites
went with their code), app 751 (was 754), console 0 (was 350). Mutants 78
(was 88): the 12 console rules and 24 rules about things that no longer exist
were replaced by 26 about things that now do — the retired role being refused
at each boundary, one company only, no cross-company reach, the DELETE
preflight, the invitation screen, the ledger filtering server-side, a queued
change never reading as delivered.

---

## 1. The SDK moved under the spec

The prompt targets "Expo SDK 51+". `create-expo-app` resolved to **SDK 57**
(React Native 0.86.3, React 19.2.3). Three things changed that the prompt could
not have known:

| Prompt says | Reality on SDK 57 |
|---|---|
| `npx expo install react-native-reanimated` | Reanimated 4 also needs **`react-native-worklets`** installed alongside it |
| `StyleSheet.absoluteFillObject` | **Removed** from RN 0.86 types — use `StyleSheet.absoluteFill` |
| `import type { BottomTabBarProps } from '@react-navigation/bottom-tabs'` | expo-router 57 **vendors** bottom-tabs internally; that package is not a dependency. Derive the type from `Tabs` itself rather than deep-importing a build path |

If you reuse `FRONTEND_PROMPT.md` for another build, §1 needs the worklets line
added.

---

## 2. Deliberate deviations

### Gauge digits do not roll — §5.6

The prompt specifies an animated rolling counter, clamped so it never lags truth
by more than 250 ms. Built instead as plain state rendered at the 2 Hz sample
rate, so it lags by **zero**.

The readout is the safety-critical half of every gauge. A rolling counter makes
that half trail the real value for aesthetic reasons. The spring stays on the
needle and value arc, which is where it reads as instrumentation. The acceptance
criterion is met more strictly than it was written.

### Pack-voltage axis is 62–90 V, not 62.4–90.0 — §5.5

Same derivation, rounded to whole volts. `62.4` with a major of 4 puts the last
tick at `90.4`, past the arc end, where `angleFor` clamps it on top of its
neighbour. `62…90` divides evenly by 4 and lands the final tick exactly on the
sweep end.

### The hero gauge has no drawn pivot — §5.2

The spec gives the hero a hub circle plus an inner dot. Built without one: at
`0.042 × size` the hub punched visibly through the digits, which is the one thing
the hero centre must stay clear. The needle now emerges from behind its readout,
as it does in the reference mock, which shows no pivot either. Metric dials are
small enough to need theirs, and keep it.

Related: hero tick labels sit at `r − 0.055 × size` rather than `r − 0.115 × size`,
hugging the ring so the centre stays clear. Measured after the change: zero
overlaps, tightest gap 9.5 px.

### History ranges are 30s / 1m / 2m — §8, screen 12

The spec says `1H / 24H / 7D`. The live BLE session buffer holds about two
minutes at 2 Hz. Offering hour and week ranges would mean inventing data or
showing empty charts. The ranges now match what the device actually holds, and
the screen states that longer trends come from the cloud telemetry history
service.

---

## 3. Built beyond the spec

These were not in either document and were added during the build:

- **Entry flow** — Login → Battery List → Connect/Authenticate/Detect → Dashboard
  (PRD §7.4), enforced by a route guard, with a dev bypass so the flow stays
  walkable without blocking daily work.
- **Session persistence** — `expo-secure-store`, 12-hour expiry, fails closed on a
  corrupt record. The BLE link is deliberately never persisted.
- **PIN / re-authentication** — PRD §6.2's optional step, applied to Critical
  parameters, salted and hashed, with attempt lockout.
- **244 tests across 19 suites**, including a mutation check on every safety rule.
- **A route-integrity guard** — see below.

---

## 4. One failure mode worth carrying into any future work

expo-router turns every file under `app/` into a route and imports it into the
app bundle. Screen tests colocated there get imported at runtime, where `expect`
does not exist, and the app dies on a blank screen.

**The entire test suite stayed green while the app was completely broken** — 191
passing tests, blank screen. Jest does not care where files live.

`mobile/__tests__/routes.test.ts` now guards it, and screen tests live in
`__tests__/`. The general lesson: a green suite is not evidence the app boots.
Run it after any change to routing, layout or project structure.

---

## 5. What connecting the app to the backend changed

The app and the backend were built separately against the same PRD. Wiring
sign-in was the first time either had to be right about the other, and two
things were not.

**The API never told the client which tenant it was in.** `/auth/login`
returned `user.companyId` but no company name, so the app fell back to its
built-in default — and that default is a literal string, `'Aurora Fleet'`.
Every tenant would have seen it. No test on either side could catch this,
because each side was self-consistent: the backend correctly returned an id,
the app correctly rendered a name it already had. Login and refresh now both
return `company`, and three tests in `backend/src/http/api.test.ts` hold it
there, including across a refresh so a renewed session is not anonymous.

**The app claimed to detect suspended accounts.** `classify()` mapped 403 to a
"this account has been suspended" message. The backend answers 401 for a
suspended account, deliberately and identically to a wrong password, so that
branch was unreachable — and had it ever been reachable it would have turned
the login form into a test for which addresses hold accounts. The outcome was
removed rather than made to work, and a test now asserts the app says nothing
distinctive about suspension.

**No first administrator could exist.** Every route that creates a user
requires an administrator, and a fresh database has none, so a deployment was
unreachable by construction. `backend/src/admin/bootstrap.ts` fires only when
the users table is *completely* empty — one existing technician is enough to
close it — so someone who can set an environment variable on a running system
cannot mint themselves an account. Verified against a live server: restarting
with a different `BOOTSTRAP_ADMIN_EMAIL` creates nothing, and that address
cannot sign in.

Two decisions in the client are worth knowing about:

**Refresh is serialised.** The dashboard polls, so several requests hit a 401
together. Each one spending the refresh token would trip the backend's reuse
detection and sign the technician out for doing nothing wrong; only the first
refreshes and the rest await it. Removing that guard fails
`refreshes once for many simultaneous 401s`.

**There is no offline fallback for sign-in.** An app that logs you in when the
network is unreachable is an app where cutting the network is the way in.
`OFFLINE_AUTH` in `mobile/src/config.ts` exists so the app is walkable before a
server runs, and it is a build-time switch on purpose — never a runtime
degradation triggered by a failed request.

**Two hand-written copies of the datasheet had drifted apart.** The app ships
`mobile/src/bms/jbd-sp24s004.json` so Settings renders with no network; the
backend seeds `parameter_definitions` from the same JBD SP24S004 datasheet.
Compared for the first time, they disagreed on **twelve fields**: eleven units
where the backend had lost the symbols (`C` for `°C`, `us` for `µs`), and
`balance_current_ma.requires_confirmation`, where the app said no and the
server said yes. That last one was inert only because the parameter is
non-writable on both sides — nothing structural was stopping it from being a
live divergence on a writable parameter.

Both were corrected, and `backend/src/policy/profileParity.test.ts` now fails
if they ever disagree again, naming the field and both values. It skips when
the app is not checked out beside the backend, so the backend still tests
alone. Injecting either original divergence makes it fail with the exact line.

At runtime the duplication is handled rather than assumed away.
`mobile/src/api/parameters.ts` reconciles the two: the server's bounds,
permissions and danger level win without exception, the bundled file keeps only
the presentation the server has no opinion on (grouping, step, precision), and
a parameter the server does not define is **dropped rather than offered** —
a control the server will always refuse is worse than an absent one, because
the technician only discovers it after committing to a change in front of a
pack. `useProfileStore` holds the result, syncs once the BMS model is known at
the end of the connect sequence, and falls back to the bundled profile when the
server is unreachable. The write screen reads from that store, not from the
bundled file.

---

## 6. On-site writes now reach the server ledger

A technician's Mode 2 writes happen over BLE, on site, often with no signal.
Until now the app was their only record — and the PRD puts the ledger of record
server-side, append-only (§7.12, §8.1). Closing that needed work on both sides,
and it turned up three defects.

**The local cap was dropping evidence.** `saveAudit` trimmed the oldest entries
past 500 regardless of whether they had ever reached a server. For a technician
working a week offsite, that silently discards the start of the week to make
room for the end of it — of the only copy in existence. The cap now reclaims
only entries the backend has acknowledged, and an entry with no sync flag counts
as unsent rather than sent.

**A battery could not be created at all.** Administrators could create
companies, users and devices, but there was no route to onboard a battery — the
product's central entity. `POST /batteries` now exists, counted against the
plan's battery limit, with serials unique platform-wide rather than per tenant:
a pack is a physical object that can be sold on or moved between fleets, and two
records for one serial would make its history impossible to follow across that
move.

**The migration was not atomic.** `db.exec(MIGRATION)` throws on a bad
statement, but the statements before it have already been applied — and since
every statement is `IF NOT EXISTS`, the next startup skips over them and the
database stays permanently half-built with nothing to show for it. Found by
putting a new index above the table it indexed. The migration now runs in a
transaction and rolls back as a unit; that was verified directly, not assumed.

The upload path itself keeps three rules:

**Nothing is retired without an acknowledgement naming it.** The server answers
with each event's stored id, and only those entries are marked sent. Treating a
200 as covering the whole batch would lose whatever it did not.

**Retrying is safe.** Each entry carries a stable client id and the server is
idempotent on it, per tenant. The technician most likely to retry is the one
with the worst signal, so a duplicated change in the ledger is the failure mode
to design against. Verified live: three events uploaded, re-uploaded whole
(3 duplicates, 0 stored), then re-uploaded with a fourth (1 stored, 3
duplicates), with identical audit ids returned each time.

**The device's clock cannot rewrite history.** `occurred_at` is the
technician's clock and `recorded_at` is the server's, kept apart on purpose —
an event uploaded three hours late did not happen three hours late, and a phone
with a wrong clock must not be able to reorder a ledger whose ordering `seq`
governs.

One thing worth recording about the tests: two mutations of the upload handler
were *not* caught, and the reason mattered. The request schema strips unknown
keys, so `actorUserId` and `source` can never reach the handler — the
behavioural tests were asserting a property that was already unreachable. The
guard now tests the stripping directly, where the enforcement actually lives,
and relaxing the schema fails it.

---

## 7. The fleet list stopped inventing packs

The battery list was a hardcoded array in the screen, and it fabricated two
things a technician could act on.

**It invented a state of charge for packs the phone had never spoken to.**
`BAT-00043` showed a confident `41%`. Nothing on screen said where that came
from or how old it was, and a bare percentage reads as current. The server now
returns each pack's last stored reading *with its `recorded_at`*, and the list
shows the age beside every number — "Reported recently", "5h ago", "3d ago", or
"Never reported" with a dash instead of a value. Only the pack this phone holds
a live link to reads as live. The dial for a stored reading is drawn at reduced
opacity by the same `stale` flag the dashboard already used.

**It invented reachability.** Rows were labelled "In range" or "Offline", and
offline rows were unselectable. Whether a pack is reachable is a BLE fact this
phone learns only by scanning, and the server cannot know it at all — so those
states were guesses presented as status. They are gone: every registered
battery is selectable, and the connect sequence reports what is actually true.

When the fleet cannot be loaded, nothing is invented. The last successful fetch
is cached so the list still opens with no signal, labelled "not confirmed with
the server"; with no cache the screen says so, and distinguishes an empty fleet
from a failed load. Injecting a fallback fleet fails
`invents nothing`; letting a stored reading read as live fails six tests.

One regression was caught by its own test while writing this: routing the chip
label through the live snapshot meant a pack that was linked but had not yet
produced telemetry lost its "Linked" marker entirely. It now reads "Linked",
then "Linked · live" once telemetry arrives.

---

## 8. Telemetry reaches the cloud without erasing the events that matter

The app samples at 2 Hz — 172,800 frames per battery per day — so raw upload
was never an option. The interesting part is what thinning must never remove.

`UploadBuffer` keeps one frame per ten seconds, **plus every frame whose fault
count differs from the last kept one**. That second rule is the whole reason
this is not a timer. The backend applies the same rule on ingest, but it can
only preserve what reaches it: a frame the phone discards is gone for good, so
this copy is the one that actually protects the event. The duplication is
deliberate and the comment in each file says so.

The bound is enforced the same way. When the buffer is full, ordinary frames
are dropped first and a frame recording a fault transition is only discarded
once nothing else remains.

Verified end to end against a live server, with a fault raised at +182s and
cleared at +186s — four seconds, entirely inside one ten-second window:

    2 Hz for 10 minutes   = 1200 frames
    after client thinning =   62 frames   (19x reduction)
    server                : received=62 stored=62 keptForStateChange=2

Both transitions survived. A plain interval filter would have dropped the whole
episode and left a history that reads as calm on both sides of it. Removing the
fault-state clause fails seven tests; letting the cap drop a transition frame
fails another.

Two smaller things this turned up:

**Telemetry was streaming with no pack linked.** `app/_layout.tsx` started the
source on mount regardless of connection state. Harmless while frames went
nowhere; once they upload, it would file readings against a battery this phone
is not connected to. It now runs only while `connectedBatteryId` is set.

**Frames are retired by count, not by emptying the buffer.** A frame that
arrives while a request is in flight was never in that request, and must not be
retired by a response that never saw it. Retiring the whole buffer instead
fails two tests; retiring on a failed upload fails three.

---

## 9. The admin console, and the bug it found

`console/` is a third codebase: Vite + React 19 + Vitest, 181 tests. It carries
the same two materials — leather masthead and rail, pinned; cream panel
content, scrolling; stitch as the only border — so the two products read as
one. Built so far: sign-in, the fleet, and the audit trail. The remaining rail
sections say they are not built rather than redirecting, because a click that
does nothing visible reads as a broken product instead of an unfinished one.

Three things came out of building it.

**The API served no browser at all.** Every previous exercise was `curl` or
`app.inject`, neither of which is a browser, so the absence of CORS was
invisible. `backend/src/http/cors.ts` adds it as an allowlist — never `*`, the
caller's origin reflected only when configured, `Vary: Origin` on every
response including refused ones (without it a shared cache turns an allowlist
into a wildcard), and no credentials, since auth is a bearer token rather than
a cookie. An unset `CORS_ORIGINS` serves no browser, which is the safe default
rather than an oversight, and startup warns about it. 23 tests.

**The console could not make a single request, with 71 tests passing.**

    TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation

The client resolves `fetch` through a getter and calls it as `this.fetch(...)`,
which makes the receiver the client rather than the global object. Browsers
refuse that. It was invisible because **every test injected `fetchImpl`** — a
plain function, which does not care about its receiver — so the default branch,
the only one that runs in production, had no coverage whatsoever. Found by
driving the real thing in a browser, not by any test.

The app's client has the identical shape. React Native's polyfilled fetch
tolerates it, so it works on device; Expo **web** — the only target actually
exercised so far — would fail exactly the same way. Both are now bound, and
both have a test that installs a receiver-checking global and fails without the
bind. That gap is the lesson worth keeping: a dependency injected in every
single test is a dependency whose real implementation is untested.

**The focus ring failed WCAG on leather.** Measured at 2.15:1 against the 3:1
a focus indicator needs — and the entire sign-in screen is leather, so it was
the first thing a keyboard user would have met. The ring is now per-surface.
This is the third time on this project that a written claim about contrast was
false until measured, and the second time the measurement was the only thing
that found it.

The palette is a hand-typed copy of the app's, which is the arrangement that
produced twelve silent divergences between the app's capability profile and the
backend's seed. `console/src/theme/parity.test.ts` reads the app's `tokens.ts`
and fails naming any token that drifts; it skips cleanly when the app is not
checked out beside it.

---

## 10. Remote support, and two bugs that only a real request could find

`console/src/pages/Support.tsx` is the console's half of Mode 1. It is built
around one sentence it must never contradict: **issuing a change is not making
a change.** Nothing on the screen shows a tick. After issuing, an administrator
is told one of two things, and neither claims the battery changed:

    Sent. A technician is on site and their app will collect it.
    Queued. Nobody is linked to this battery, so it will wait until someone is.

Both were verified against a live server, with a technician's BLE session
opened and then allowed to go stale — the screen correctly moved from "A
technician is linked to this battery" to "Nobody is linked" on its own, because
`SESSION_STALE_MS` is 30 seconds and nothing had sent a heartbeat.

Force Push says what it does *not* do, at the point of use: it moves a change
ahead of other queued work and delivers it no sooner, because a technician
still has to be there. Removing that sentence fails a test.

The value field warns when a value is outside the permitted range but does not
block it, and the server's refusal is what actually stops it — PRD §5.2, seen
working live:

    client:  Outside the permitted range for this parameter. The server will refuse it.
    server:  Cell over-voltage must be between 3.7 and 3.8 V

The refusal then appeared in the audit trail as `Refused`, which is the
backend's "denials are audited" rule finally visible in a user interface.

**Two real bugs came out of driving it.**

`POST /batteries/:id/session` takes no body. The console's client — like most
API clients — sent `content-type: application/json` with nothing after it, and
Fastify rejects that outright. The client now declares JSON only when there is
a body, and so does the app's, which had the same latent fault on every
bodyless POST it will make once `BleSource` lands.

Worse, that rejection came back as a **500**. A malformed request is the
client's fault, and answering "Something went wrong" tells them the server is
broken while burying a fixable client bug. `toApiError` now passes through
Fastify's own 4xx statuses with their real messages; 5xx still says nothing,
because that genuinely is a bug and its detail is not the caller's business.

Finding it was harder than it should have been, which was itself a defect: the
error handler mapped everything unrecognised to 500 and **logged nothing**. A
500 that leaves no trace on the server cannot be diagnosed in production, which
is precisely when it matters. Unhandled errors are now recorded server-side
while the response stays deliberately silent.

---

## 11. The console is complete

Users, devices and companies are built; every rail link now goes to a real
page and the "not built yet" placeholder is gone. 254 tests.

**Creating a user means setting their first password, and that is a weakness.**
The API has no invitation flow and there is no email infrastructure behind it,
so an administrator ends up knowing somebody else's password — which they
should not. Rather than hide that behind a password field, the console
generates the password itself, shows it exactly once, and says plainly that it
cannot be shown again. Generating it removes two failure modes (a weak password
and a reused one) but not the third. **The real fix is a one-time invitation
link and a password the user sets themselves; it is a backend change and it is
not done.** It is recorded here so the current arrangement is not mistaken for
a finished design.

The generated alphabet excludes `l`, `I`, `O`, `0` and `1`, because a first
password is read aloud or pasted into a chat and those are where transcription
goes wrong. Verified end to end: a password the console generated and displayed
was used to sign in against the live API.

**Suspension says what it does.** The backend revokes every refresh token the
account holds, so it takes effect immediately rather than whenever a token
happens to expire, and the console says "signed out everywhere" rather than
leaving that to be discovered. The last-administrator refusal is surfaced
verbatim from the server — confirmed live, the only administrator cannot
suspend themselves, and the row for your own account offers no action at all.

**Quarantine and revocation are not the same word.** Both stop a gateway
working; one is a pause while something is checked and the other is final. They
are labelled and explained separately, and a revoked gateway offers no routine
way back. Verified live: quarantining a gateway reported "The app will refuse
this gateway. Reversible once it has been checked." and the row's actions
changed accordingly.

Two smaller decisions worth recording: a blank battery limit sends `null`
rather than `0`, because no limit and a limit of zero are different things; and
an administrator sees no seat count, because seats are a per-company limit and
one number across every tenant would be meaningless.

---

## 12. Invitations

The weakness recorded above is fixed. A user is now created **by invitation**:
the account has no usable password, cannot be signed into, and a single-use
link lets the person set one themselves. Nobody else ever sees it.

Two independent reasons an invited account is unusable, on purpose: its status
is not `active`, and `password_hash` holds `$invited$`, which is not a valid
scrypt hash — `verifyPassword` fails closed on a malformed hash, so the account
would still be unreachable if the status check were somehow missed.

The token is stored hashed, like a refresh token: a database dump must not hand
someone every outstanding invitation. It is returned exactly once, at creation,
and the server cannot produce it again.

**Every failure reads identically.** Unknown, expired and already-used all
return the same message, because distinguishing them would let a guessed token
learn whether it ever existed. The one exception is a password below the
minimum length, which is safe to name — the caller already holds a valid
invitation and "too short" is the only actionable failure. Attempts are
rate-limited on the token so a stolen link cannot be brute-forced.

**What this still does not fix.** There is no email delivery, so an
administrator has to hand the link over, and whoever holds an unused link can
claim that account. Single use and a seven-day expiry bound it. The console
says exactly that at the point of handover — *"Until they use it, whoever holds
this link can claim the account. Send it over something private, not a shared
channel"* — rather than presenting the link as though it were safe. When email
delivery exists, only the delivery changes; nothing else does.

An invited account cannot be flipped to `active` by hand, because that would
produce an account that looks usable and cannot be signed into. Suspending one
is how an invitation is cancelled, and the console labels that button
"Cancel invitation" rather than "Suspend".

Verified against a live server: invited → cannot sign in → accepts → signed
straight in with the right company → can sign in normally → the link is spent,
and a reuse attempt leaves the first password untouched.

Two bugs surfaced while wiring it. `InvitationError` was not in the HTTP error
map, so a too-short password came back as a **500** rather than a 400 — caught
because the unhandled-error logging added in §10 finally made a 500 visible.
And after accepting, the person stayed on the invitation screen: signed in, but
looking at a form that appeared not to have worked. They are now redirected,
and a technician who accepts is told plainly that their password is set but the
console is not their tool — `acceptInvite` had been skipping the role check
that `signIn` has always done.

---

## 13. Deployment readiness

**`/health` said the process was fine while the database was gone.** It
returned `{ok: true}` without touching anything, so an orchestrator would have
kept a broken instance in the rotation indefinitely. There are now two probes,
and the distinction is the point:

- `/health` — liveness. Deliberately touches nothing, because restarting a
  process is the wrong response to an unreachable database.
- `/ready` — readiness. Runs a real query against a real table, not `SELECT 1`:
  an open handle to a file that has been truncated or replaced answers
  `SELECT 1` quite happily and fails on anything that reads a page. Returns 503
  when the database is silent or the parameter seed is missing, because a
  process that cannot evaluate a policy should not be taking writes.

**There were no security headers at all.** Three now, and the reasoning is in
`http/headers.ts`. `Cache-Control: no-store` is the one that matters: these
responses are audit trails, user lists and tenant battery data, and a shared
cache holding one tenant's and serving it to another is a real leak. `nosniff`
because the bodies carry user-supplied strings. `X-Frame-Options: DENY` because
a framed JSON response is only ever part of an attack.

Deliberately absent: `Strict-Transport-Security`, asserted by a test. It
belongs at whatever terminates TLS — that is where the certificate lives and
where preloading is decided — and claiming it from a process that may
legitimately be reached over plain HTTP inside a network would be asserting
something it cannot know.

The request body limit was already sound: Fastify's default answers a 2 MB
body with a 413.

**There was no README.** Three codebases and no instructions to run any of
them. There is one now, and every claim in it was checked rather than written
from memory: the file paths it names, the npm scripts it quotes, and the
quickstart run verbatim end to end — bootstrap admin created, both probes
answering, headers present, the admin signing in, and the CORS origin it
suggests actually accepted.

---

## 14. The fleet table was a dead end

Clicking a row did nothing. `console/src/pages/Battery.tsx` is what a serial now
leads to: what the pack is, what it has reported, and every change made to it,
on one page.

**The charts lift the pen across a reporting gap.** The app uploads only while
a technician is linked, so a series can jump hours between points — and joining
those with a straight line would assert a state of charge for a period nobody
measured. That is the same dishonesty the fleet list avoids by printing an age
beside every number, and it would be easier to commit here because a smooth
line looks *better*.

`api/history.ts` finds the discontinuities and `pathFor` emits a fresh `M`
at each one. Verified in the browser against a live server, with two reporting
sessions three hours apart:

    60 points · 2 move commands · 58 line commands · break at index 30

Two move commands is the pen lifting once, in the right place. Drawing through
the gaps fails two tests; removing gap detection entirely fails seven.

Each chart's accessible name carries the numbers rather than describing a
shape — the range, the reading, and how many gaps there are — because somebody
who cannot see the line still needs to know the series is discontinuous.

State of charge is drawn against a fixed 0–100 floor and ceiling. A percentage
chart auto-scaled to 41–44% exaggerates every wiggle into a cliff; ignoring the
floor fails a test.

The page also carries that pack's own slice of the audit trail, which is where
the backend's "denials are audited" rule finally becomes useful to somebody —
a refusal and a queued change sit side by side under the pack they were aimed
at.

---

## 15. A bug I wrote, and the filtering that fixes it

The battery page fetched the audit trail and narrowed it in the browser:

```ts
listAudit(api)                                  // capped at 200, fleet-wide
setEvents(audit.filter((e) => e.batteryId === id));
```

`queryAudit` defaults to **200 rows and orders newest first**. So a pack whose
changes fall outside the 200 most recent fleet-wide events would render
*"Nothing has been changed on this pack."* — not an empty result, but a false
statement about an audit ledger, on the page an administrator would go to
precisely because they suspected something had been changed.

Demonstrated rather than argued, against a live server with one old change on
one pack and 250 newer ones on another:

    unfiltered page: 200 events (server cap)
      does BAT-OLD's change appear in it? False
    filtered by battery: 1 event -> ['cell_ovp']

Filtering is now the server's job everywhere. `listAudit` takes a filter and
builds a query string; the battery page passes `batteryId`, and the audit page
has outcome and source filters that go the same way. The test that guards it
asserts the **request** carries the filter, because a test that only checks the
rendered rows passes either way when the fixture is small — which is exactly
how the bug survived being written.

Two smaller things the cap made worth saying:

**A full page says it is full.** Exactly 200 rows is more likely a truncated
view than a complete one, so the caption says "Showing the most recent 200;
there may be more" rather than letting it read as the whole history.

**An empty filter is not an empty trail.** "No changes match that filter" and
"Nothing has been changed yet" are different statements, and conflating them
would tell an administrator their fleet had never been touched.

---

## 16. Looking for the same bug's siblings

Finding one instance of "fetch a capped list, narrow it in the browser" is a
reason to look for others rather than assume it was unique. A sweep of every
`.filter` and `.find` across the console and the app found no second instance —
each remaining one operates on a local array or an uncapped endpoint. But it
turned up two things worth fixing.

**`GET /batteries` was unbounded.** Every row, every time. That is one large
tenant away from being a problem for everyone on the instance. It is bounded
now (500 by default, 2000 at most) and the response carries `truncated`, so the
fleet page says *"Part of your fleet — there are more packs than this page
returned"* rather than letting a partial list read as the whole one. Verified
live: `limit=5` returns 5 with `truncated: true`, and `limit=999999` is clamped
rather than obeyed.

**`GET /batteries/:id` existed but omitted the last reading**, so the detail
page picked its battery out of the fleet listing instead. That works until the
listing is paged — which it now is — and then quietly stops finding batteries
that plainly exist. The route returns the same shape as the list, and the page
fetches one battery. A 404 renders as "not in your fleet" rather than an error,
because the server deliberately does not distinguish "not yours" from "not
there" and neither should the console.

**One mutation was not caught, and that was the useful part.** Removing the SQL
`LIMIT` left every response byte-identical, because the slice still happened in
JavaScript afterwards — so no HTTP-level test could see it. The protection is
that the *database* is never asked for every row, which is invisible from
outside. The test now records the SQL the route issues and asserts it carries a
`LIMIT`; removing it fails.

That is the second time on this project a mutation check has found a test
proving something adjacent to the property it claimed. The first was the
console's `fetch` binding, where every test injected a stand-in and never
exercised the real one.

---

## 17. The chrome finally has tests

`LeatherPanel`, `StitchBorder`, `ScreenScaffold` and `StaleBanner` are what
every screen in the app is built out of, and they carried the design language's
two load-bearing rules with nothing checking either. A rule nothing checks is a
convention. 29 tests now, and all six mutations are caught:

- a solid stitch instead of a dashed one — 11 tests
- a stitch that swallows taps meant for the panel beneath it
- the leather stitch used on cream, or the reverse — the single change that
  breaks the two-material language
- a scaffold that scrolls its leather header along with the body
- a back control below the 44pt target
- a stale banner that says "went stale" when it means "never received"

They are found by the styles that carry the rules rather than by a `testID`.
Adding a marker purely so a test could locate them would be testing the
marker: the stitch is identifiable precisely because it is the only dashed
border in the app, and a test that says so is checking the rule itself.

**Two things about the test harness were learned the hard way.** RNTL returns
`null` from `toJSON()` on the third render inside a single test when there are
`unmount()` calls between — so each tone gets its own test rather than a loop.
And `fireEvent` is async in v14: the unawaited press had already been recorded
in §4 of this document, and it still cost time here, so it is worth repeating.
Both were found by instrumenting the failing test rather than reasoning about
it, after an identical probe passed in isolation.

---

## 18. The loop that was never closed

Every piece of the on-site write path was tested — the write flow, the local
audit store, the outbox, the server's ingest — and the whole was still wrong.
`sync` ran **only on connect**. So a technician who linked to a pack, made five
changes and disconnected carried the only record of those changes away on their
phone, until they happened to link to that same pack again. If they never did,
it never left.

Nothing failed. Every component test passed, because each component did its own
job correctly. What nothing tested was *when*.

An entry is now pushed as soon as a write completes, and again when the link
closes. Neither is awaited — the write is already done and the technician must
not wait on a network for the app to say so — and a failure leaves everything
queued, because those entries are still the only record that a change reached a
real pack.

`src/store/uploadTiming.test.ts` tests the sequence rather than the parts:
closing a link pushes what was recorded during it, a failed push keeps the
entries, signing out does not discard them.

**One mutation was not caught on the first attempt** — removing the per-write
push — because nothing exercised it. That gap is the same one this whole
section is about, one level up: the behaviour was added and not tested. The
write-flow tests cover it now, and removing the push fails them.

Two notes on the tests themselves. The write flow deliberately pauses on
read-back and auditing, so a test can finish while its own write is still
settling and the tail lands in the next test — which produced a "was this
called" assertion answered by the *previous* test. Each case now waits for its
flow to finish, and entry counts are asserted as deltas rather than absolutes,
so a slow settle reads as slow rather than as a product bug.

Verified live: three writes uploaded one at a time as they completed, each
stored exactly once, and the pack's ledger holds all three — including the
`indeterminate` one, which is the outcome most worth not losing.

---

## 19. Mode 1 had no second half

Checking the other loops after §18 found a worse one. **The app never claimed
commands.** There was no code anywhere in `mobile/` that called
`/batteries/:id/commands/claim`.

So the product's defining capability was open end to end: an administrator
opens a support session, issues a change, the server queues it, and the console
reports *"Sent. A technician is on site and their app will collect it."* Nothing
collected it. The technician's passive banner — built, styled and tested —
could never fire, because nothing ever produced an admin-sourced entry.

Everything around the gap was verified. The broker's HTTP surface is tested
both ways, and I had run the whole path live several times with `curl` standing
in for the app. That is exactly what made it invisible: the stand-in did the
one thing the real client did not.

`src/api/commands.ts` and `src/store/useRemoteChangeStore.ts` are the missing
half. Three properties shape them:

**Claiming is collection, not consent.** No accept step, no prompt. PRD §6.3 is
explicit that an admin remote write never asks the technician — they are told
afterwards. A confirmation dialog here would quietly turn Mode 1 into something
else.

**A claimed command must be reported.** The server marks it `claimed` the
moment it hands it over, so one claimed and then dropped is stuck: never
re-issued, never completed. Every claim is followed by a report, including for
outcomes nobody likes — a parameter this build does not know is reported
`rejected` rather than dropped, which releases it.

**Only a confirmed read-back changes what the app claims is on the BMS**, the
same rule a local write follows.

A test caught a real ordering bug while this was being written: the overlap
guard was raised *after* awaiting the claim, so two polls both got past it and
both claimed — the one thing it exists to prevent.

**And the first mutation was not caught: removing the call that starts the
poller.** I had wired it and not tested the wiring, which is the identical
mistake §18 is about, one turn later. It is covered now, and the mutation
fails.

Verified live, the whole path in seven steps: issued with nobody on site →
queued; app polls → nothing; technician links; app polls → claims it; reports
the result; the ledger records it against the administrator who asked, tagged
`admin_remote` with the support session; nothing left queued.

---

## 20. The loop was open one link further back

The fix in §19 was inert. **The app never registered its BLE session with the
server**, so `claimCommands` would have returned nothing forever.

The server decides who is on site from its own records, never from what a
caller asserts — which is right, and is the reason this mattered. Registering
presence is not bookkeeping beside the claim; it is the precondition for it.
An app that never announces itself can never collect anything, however
correctly the collecting is implemented.

`src/api/presence.ts` and the poller now announce presence **first, every
pass** — announcing after claiming would mean the first pass of every link came
back empty — and end it deliberately on disconnect rather than letting it age
out. Thirty seconds in which an administrator believes somebody is standing at
a pack they have walked away from is thirty seconds in which a change is issued
as deliverable and then waits indefinitely.

**Why two turns of verification missed it.** Every live run of Mode 1 used
`curl` in place of the app, and the curl script opened the session because that
is what the API documentation implies you do. The stand-in did the one thing
the real client did not. The verification was real; the substitution was the
flaw.

So this run drives the app's **own modules** against the live API, with nothing
standing in:

    console: issued a change -> queued
    console: is anyone on site? {'active': False}
      app: announcePresence -> {"sessionId":"c3836d8b…"}
      app: claimCommands    -> 1 command: cell_ovp=3.78
      app: reportResult     -> true
      app: endPresence      -> done
    console: is anyone on site now? {'active': False}
    console: ledger has 1 applied change, source=admin_remote

**The lesson worth keeping is about verification, not about presence.** A test
double that behaves better than the real thing hides exactly the bug it was
meant to find — the same shape as the console's `fetch` binding in §9, where
every test injected a stand-in and none exercised the real implementation.
Three times now: prefer driving the real client, and when a double is
unavoidable, ask what it does that the real thing might not.

---

## 21. Applying the rule to everything else

§20 ended with a rule: prefer driving the real client, and when a double is
unavoidable, ask what it does that the real thing might not. Several other
seams were verified only through the same substitution — the telemetry upload
was checked with a Python script that reimplemented the thinning, the audit
outbox and sign-in with `curl`. Each of those is a place the same bug could
have been hiding.

`mobile/scripts/liveCheck.mts` (`npm run live-check`) drives the app's own
modules against a running backend: its API client, its profile reconciler, its
`UploadBuffer` and uploader, its audit outbox, its presence and command code.
22 checks, one tenant per run so a repeat cannot collide with real data.

Nothing further was inert — but the harness immediately caught a flaw in one of
its own checks, which is worth recording because the shape recurs.

**The check was wrong, not the product.** It asserted the server had kept two
frames "for a state change" during a fault episode, and got one. The fault
began at frame 40, which lands exactly on a ten-second boundary — so that
transition was due by the schedule anyway and correctly was not counted as
*rescued from* the schedule. The check was measuring a counter rather than the
property, and a counter that happens to include an on-schedule frame proves
nothing.

The fault now starts off the boundary, and the assertion is on the stored
history: the moment it was raised is findable, the moment it cleared is
findable, and the episode spans one reading rather than being smeared across
the series. That is the thing that would actually matter to somebody reading
the history after an over-temperature — and it fails if the thinning ever drops
the episode.

---

## 22. The console gets the same treatment

Every test in `console/` injects a `fetchImpl`. That is the precise arrangement
that hid the client's `fetch` binding bug in §9 — the console could not make a
single request in a browser while 71 tests passed, because none of them ever
took the default branch. Leaving that package verified only by stand-ins, one
turn after writing a rule about stand-ins, would have been the wrong lesson to
draw.

`console/scripts/liveCheck.mts` drives the console's own modules against a
running backend: sign-in through the real `ApiClient`, companies, invitations
end to end (issued, accepted, and refused on reuse), users and seats, the fleet
listing and single-battery read, history and its gap detection, remote support
including a policy refusal, audit filtering on all three axes, and device
quarantine. 32 checks, its own tenant per run.

Nothing was inert. Both harnesses now cover every seam either client has with
the API, and both are in the README next to the unit tests rather than as
something a maintainer has to know exists.

Worth noting what the run actually proved rather than just that it was green:
closing a support session reported **2 cancelled** — the queued change *and*
the deliverable one, because no technician had claimed it. That is the rule
from §6.3 working on real data: a command issued during a call does not
outlive the call.

---

## 23. One command, and the bug it had immediately

Roughly 1,400 tests, two live-check harnesses, three typecheck targets, two
lint targets and two cross-package parity tests, and nothing ran them together.
`./verify.sh` does: all three packages, then the backend on a throwaway
database with both live checks driven against it.

**The first version printed "Everything passed" while a live check was
failing.** Each step ran inside a subshell — `( cd mobile && run … )` — and
`FAILURES+=(…)` inside `( … )` never reaches the parent. Every recorded failure
was discarded at the closing bracket.

A verification harness that reports success on failure is worse than no
harness, because it converts an unknown into a false assurance. It is also
precisely the class of defect this whole document is about, committed in the
tool built to catch it.

So the fix was checked the way everything else here is: a real regression was
injected — the console's audit filter dropped, the same bug §15 records — and
the harness was confirmed to fail, name both the unit test and the live check,
and exit non-zero. Then reverted, and confirmed green.

`.github/workflows/ci.yml` runs the same script. One job rather than three:
splitting the packages into parallel jobs would leave the seams between them
unchecked, and the seams are where most of this project's real bugs have been.
It uses `npm ci` so a drifted lockfile fails rather than being silently
repaired, and dumps the server log on failure — because §10 established that a
failure leaving no trace cannot be diagnosed.

At the time it was written the repository was not under git, so nothing ran it,
and the README said so rather than implying a green badge that did not exist. It
first ran when the project was pushed to GitHub — see §33.

---

## 24. Finding the gaps by breaking things, not by reading

Three UI components had no tests: `PinPad`, `StepList` and
`PassiveChangeBanner`. Rather than write tests for all three, each was
**mutated first** to find out which were actually uncovered — a component
exercised indirectly by screen tests does not need its own file.

That found the answer quickly and unevenly:

- `PassiveChangeBanner` — making it never appear failed a test. Covered.
- `PinPad` — **every guard could be removed and the suite stayed green.**
- `StepList` — marking every step complete went unnoticed.

The same probe also settled a question worth asking directly: is the PIN gate
on critical writes actually wired, or decorative? Removing it fails two tests.
It is wired, and mutation answered in seconds what reading the code would have
answered less certainly.

**Why the `PinPad` gap mattered.** `onComplete` runs the PIN check, and a
failed check spends one of a small number of attempts. Firing it on every
keypress would spend an attempt per digit and lock a legitimate user out
partway through typing their own PIN. A weakened availability guarantee on a
security control is still a weakened security control — and nothing would have
noticed.

`StepList` exists so somebody can see *which* stage failed rather than only
that something did. Every step reading complete defeats the entire reason for
the component, and its three states — done, active, pending — are now asserted
as three, not two.

Five mutations, all caught: completing on the first digit, accepting entry past
the PIN length, ignoring the disabled flag, marking every step complete, and
making the active step indistinguishable from a pending one.

One note on method. Two of those mutation runs silently did not execute at all,
because the shell loop driving them split its fields on `|` and the code being
injected contained `||`. The tests reported green for a mutation that was never
applied — the same false-assurance shape as §23's subshell bug, in a throwaway
loop rather than a committed script. Both were re-run individually. A mutation
check that does not visibly change the code is not a mutation check.

---

## 25. The app shipped with three changes that never happened

`useActivityStore` seeded its timeline with three example entries so the screen
and the passive banner could be looked at before any real write existed. One of
them was attributed to *"R. Mehta (Admin)"* — a person who does not exist — and
the banner pointed at it on first launch.

Cosmetic, until §18 made `sync` fire on connect and after every write. Then a
fresh install would have **pushed three invented changes into the audit ledger
on its first connect**. That ledger is append-only: a database trigger forbids
updates and there is no delete path at all. The fabrications would have been
permanent, in the record of what happened to a physical battery.

Confirmed before fixing, not reasoned about:

    entries on a fresh install: 3
    of those, uploadable:       3
    banner points at:           a3
    their actors: R. Mehta (Admin), You, You

Two guards now, because one is not enough for something this shape. The seed is
behind `DEMO_ACTIVITY` and is absent from a release build; and every seeded
entry is marked `synced: true`, so the outbox skips it however the flag is set.
The second guard is the one that matters — a flag can be flipped by mistake,
and the ledger cannot be un-written.

**Two rounds of my own tests were vacuous, and the reason is worth recording.**

The first asserted `pending(useActivityStore.getState().entries)` was empty —
but the `beforeEach` above it empties `entries`, so it was asserting
`pending([]) === []`. Trivially true whatever the seed contained. It caught
none of three mutations, including the original bug.

The second read the real initial state but tested the flag branches as
`DEMO_ACTIVITY ? … : …`. Under jest `__DEV__` is true, so `DEMO_ACTIVITY` is
always true and a guard written directly against it is **indistinguishable from
no guard**. The test could only agree with itself.

The fix was to make the property a function of the flag —
`initialEntries(demo: boolean)` — so both answers are reachable without
pretending about the environment. All three mutations now fail: an unmarked
seed, a seed that ignores the flag, and a banner that fires regardless.

This is the pattern §20 named, committed twice more by the person who named it.
Writing a rule down does not make one follow it; running the mutation does.

---

## 26. The app was uploading invented telemetry

Looking for more of §25's shape found a much larger source. `USE_MOCK` is on,
`MockSource` fabricates readings at 2 Hz, and **nothing in the upload path knew
or cared.** Every sixty seconds while linked, invented values went to
`telemetry_readings` — and from there into the fleet list as "Reported
recently" and into the battery detail charts as history.

Confirmed before fixing:

    MOCKFRAMES 5  BUFFERED 5
    PAYLOAD {"soc":72.81104933906448,"packVoltage":81.09148745027068,
             "packCurrent":142.50358388996742,"temperatureC":29.16951469413343,…}

Three invented decimals that a fleet list would render as a measurement from a
physical pack. There is nothing about `72.81 %` that says it was made up.

Two guards again, and the same reasoning as §25. `TelemetrySource` now declares
`simulated`, and `UploadBuffer.offer` refuses anything that says true —
refused, counted, and not allowed to disturb the thinning of real frames
either, so the first real frame after a mock session is not thinned away for
arriving too soon after something that was never uploaded.

The declaration lives on the source rather than being read from `USE_MOCK`
because a flag is one edit away from being wrong and nothing downstream could
tell afterwards. A mock session still drives every gauge and every screen; it
simply never reaches the server.

**Two of three mutations were not caught on the first attempt** — the store
passing the flag to the buffer, and `MockSource` truthfully declaring itself.
Both are wiring rather than logic. That is the third time in five sections:
build the guard, test the guard, forget that nothing tests whether the guard is
reached. `sourceProvenance.test.ts` now covers the end-to-end property — a mock
session produces a snapshot, fills the on-screen history, and buffers nothing —
and both mutations fail.

---

## 27. Sweeping for the rest of it

Two turns running had found fabricated data reaching real systems, so rather
than wait for a third, the repo was swept for that whole class. It found three
more, all of them display rather than upload — and display is where this
product's discipline actually lives, since a technician reads a screen and
acts.

**The Device screen invented a gateway identity.** `KYE-000184`, `HW 1.0`,
`FW 1.2.4`, and `Last seen: just now` — four plausible values for a device the
app has no way of identifying, because a gateway reports its own serial and
firmware over BLE and that path does not exist. It now says "Not reported yet"
and explains why. The battery row shows the pack actually linked.

**The Support screen showed an open session that did not exist.** A session id,
an administrator named *R. Mehta*, "started 4 min ago", and a pulsing *Live*
indicator. Somebody standing at a pack would have believed an administrator was
in a session with it at that moment. It now reads `/support-sessions`, shows
the real open one for the connected battery or says there is none, and the
*Live* indicator appears only when something is.

It also distinguishes **"could not check" from "there is no session"**. Saying
the second on a failed request is the same lie in a quieter voice.

**`Aurora Fleet` survived as a fallback.** §5 fixed the login path to use the
tenant's real name; the restore-from-storage path still defaulted to a literal.
There is now nothing plausible to fall back to.

Lint then caught a real defect in the fix itself: the Device screen's new
"Last seen" read `Date.now()` during render. That is impure — the age would be
whatever it was when React last happened to re-render, which for a screen
nobody is touching means frozen at the moment it opened. A stale age presented
as current is the same failure as the invented one it replaced, arrived at more
subtly. It uses `useFreshness`, which already existed and ticks on its own
interval for exactly this reason.

Two notes on method, both repeats of lessons already in this document.

A mutation appeared not to fire and the first instinct was to conclude the
guard was covered. Checking whether the edit had landed — §24's rule — showed
it had, and the gap was real.

And the gap was this: the screen test mocks `listSupportSessions`, so it proves
the screen handles `null` correctly and proves nothing about whether `null` is
ever returned. Changing the module to return `[]` on failure — making a network
error read as "no session is open" — passed that test untouched. The fix was a
direct test of the module against a failing client. Same shape as §20 and §26:
**a double that behaves better than the real thing hides the bug it was meant
to catch.**

---

## 28. Finishing the sweep: the Dashboard

The §27 sweep covered the stores and two secondary screens. Finishing it across
every screen found three more literals on the **Dashboard** — the one a
technician looks at most:

    Device            KYE-000184
    Activity          3 writes
    Support session   SS-4471 active

The third is the worst. The busiest screen in the app asserted that an
administrator had a live session with the connected pack, permanently, whether
or not one existed.

All three read real state now. The support state moved into
`useSupportStore`, shared with the Support screen — two screens showing the
same fact must not be able to disagree, and they did: each invented its own
version.

**Three states, kept distinct.** "Checked and there is none", "could not check"
and "not checked yet" are three different things to tell somebody standing next
to a battery, and collapsing them is how a network failure comes to read as an
all-clear.

A test caught genuinely ambiguous copy: the empty state read *"None open"*,
which shares a word with *"Session open"*. On a glanced-at row those are
mistakable, so it now reads *"None"*.

**And the first mutation was not caught again** — replacing the row's value
with the literal. The store behind it was tested; the wiring was not. That is
the fourth time in this document, and the pattern is exact enough to state as a
rule: *a guard and its call site are two changes, and a test of the guard is
not a test of the call site.* The dashboard rows now have their own tests, and
all three mutations fail.

Those tests needed one adjustment worth noting. Seeding the store was not
enough, because the screen refreshes on mount and overwrote it — so the tests
control the fetch instead. A test that sets up state the code under test then
discards is testing nothing, quietly.

---

## 29. Making the discipline checkable

Mutation testing has been the single most productive practice on this project.
It found the `fetch` binding, the SQL `LIMIT` whose removal changed no
response, the uploadable seed, the invented telemetry, and four separate cases
of a guard tested thoroughly while nothing tested whether it was reached. Every
one of those passed a full green suite first.

It was also entirely ad hoc — shell one-liners, retyped each time, and twice
silently broken (§24's `IFS` collision, §27's anchor that did not match).

`mutants.json` and `mutants.mjs` make it a command. 33 rules across all three
packages, each recording what it breaks and why that matters, so the file
doubles as a statement of what this system is actually trying to hold.

**All 33 are caught.** The console was swept for §27's class first and was
clean — the only literals in it are `<option value>` enums.

The tool reports **three** outcomes rather than two. A mutant whose anchor no
longer matches the source was never applied, and reporting that as a pass would
be exactly the false assurance it exists to find — the same shape as §23's
subshell bug and §24's mangled loop. It is reported as a broken mutant instead.

That distinction was verified rather than assumed: a deliberately uncovered
mutant (a comment edit) and a deliberately stale anchor were added, and the
tool reported one survivor and one unapplied mutant, exiting non-zero. Then
removed.

It is not part of `verify.sh`, because it runs the full suite once per rule and
that is minutes rather than seconds. It is the thing to run when adding a rule,
or when a test suite starts feeling reassuring.

---

## 30. Auditing the mutation suite itself

A suite of 33 rules says nothing about the rules it does not contain. Comparing
`mutants.json` against the files that actually claim invariants found **twelve
safety-critical files with no mutant at all** — among them the policy engine,
tenant scoping, token handling, password verification and the write-outcome
classifier, which are close to the most important code in the system.

Twelve more mutants, 45 in total. Eleven of the new ones were caught
immediately. One was not.

**Nothing tested that password verification fails closed.** That property is
load-bearing twice over: a corrupt record must refuse a sign-in rather than
crash the path, and an invited account stores `$invited$` rather than a hash —
its unverifiability being the second of the two independent reasons such an
account cannot be signed into.

The first attempt at a test still did not catch it, and the reason is the sharp
part. A fabricated hash from another algorithm is refused **anyway**, because
its digest does not match — so the test passed with or without the guard and
proved nothing. What demonstrates the property is a *real* scrypt hash with
only its algorithm label changed: correct password, genuine parameters,
everything valid except the word `scrypt`. That one verifies without the check
and is refused with it.

The distinction is worth stating plainly, because it is the same one that has
recurred all through this project in different costumes: **a test that passes
whether or not the code is correct is not a test of that code.** Here it took
the form of choosing an input that fails for the wrong reason.

---

## 31. Closing the three gaps, and the subscription model

The audit in §31 named three limits that were stored, shown, and never checked.
All three are now enforced, and the subscription model they belong to is built.

**Access is granted, not sold.** Payment happens outside KnowyourEV. An
administrator switches a company on for a year from that moment
(`grantAccess`), picks a seat tier, and the term runs from *now* — renewing
early forfeits the remainder, which is a real trade and is named at the call
site rather than left to be discovered. `adjustLimits` changes what a live plan
allows without restarting its term, because adding seats in month ten should
not silently buy another year.

**Sign-in checks the company, not only the user.** `entitlementOf` runs at login
*and* at every refresh, so a company suspended mid-session loses access within
the access token's fifteen minutes rather than whenever somebody happens to sign
out. It answers **403, not 401**: the credentials were right, and "email or
password is incorrect" is both false and unactionable. Somebody whose employer's
plan has lapsed needs to know to ring their administrator.

**Guest users.** A company creates a user to solve a problem and removes them
when it is solved. `removeUser` deletes the account outright — unless it has
history, in which case it is suspended instead, because an append-only audit
trail with a dangling actor is not an audit trail. Every foreign key is
enumerated explicitly; the first version passed its test only because the test
user had never signed in.

### The two things called "devices"

The user's requirement had two different limits in one word, and separating them
is most of this section:

- **`device_limit`** — KnowyourEV gateways the company may register. Enforced in
  `registerDevice`; a revoked gateway frees its slot.
- **`session_device_limit`** — phones and browsers the company-owner account may
  be **signed in on at once**. Default two, raisable per company by an
  administrator.

They are stored in different columns, asked as different questions, shown in
different console columns ("Gateways" and "Sign-ins"), and there is a test whose
only job is that moving one does not move the other. Calling both "devices" is
exactly how they get conflated, so nothing in the code does.

**A third sign-in signs out the oldest rather than being refused.** Two reasons,
both worth stating:

- There is no email and no self-service recovery, so a refusal would lock an
  owner out of their own account the day they replace a phone.
- Being signed out unexpectedly is a *signal*. Somebody who did not sign in
  anywhere new has just learned that somebody else did — which a refusal hides
  from them entirely.

So the login response carries `signedOut`, and the app shows a dismissible
banner naming the device and saying to change the password if it was not them.
A silent eviction would be the same event with the only useful part removed.

The cap runs **after** the password and the entitlement check, never before. A
mutant that moves it earlier is in the suite, because enforcing it first would
hand anyone who knows an owner's email address a free denial of service:
repeated wrong-password attempts would sign that owner out over and over.

### What the mutants caught this time

Eighteen new rules, all of them killed. Two were worth the exercise on their
own:

- **The console pre-filled the sign-in cap from the gateway limit.** Every test
  passed. An administrator opening "Renew or change" on a company with forty
  gateways would be shown *40* as the suggested sign-in cap, and three presses
  of OK would silently raise a cap of two to forty. The tests asserted what was
  *sent*, never what was *suggested* — so the fix was to assert the prompt's
  default, not just its answer.
- **A 403 read as "check your connection".** The backend's actionable message
  was built in this same pass; the app's `classify` had no case for 403, so it
  fell through to `unreachable`. A technician standing in a depot would have
  been sent to debug their signal instead of ringing the one person who could
  fix it.

And one blind spot that was not a mutant at all: `OFFLINE_AUTH` is
`__DEV__ && true`, and `__DEV__` is true under jest — so `signIn` short-circuits
and **the entire real sign-in path was unreachable from any test**. The new
store test mocks the flag off. Worth knowing that anything reached only through
`signIn` is untested by default.

### Two things the harness itself was not checking

**The live-check scripts were not typechecked.** `mobile/tsconfig.json` included
`**/*.ts`, and that glob does not match `.mts`. So `scripts/liveCheck.mts` — real
code, driving the real client modules, the thing this project leans on hardest —
was compiled by nothing until a duplicate `const` reached a live run and esbuild
caught it. `**/*.mts` is now included, and re-introducing the same collision now
fails `npm run typecheck`. The console's config included `scripts` as a
directory, which does pick up `.mts`, so only one of the two was blind.

**The console suite was flaky, and it looked like a bug.** Roughly one full run
in four failed with six to eight tests across unrelated files — batteries,
users, audit, companies — never the same ones twice, and never when a file was
run alone. It reads exactly like a real intermittent defect. It was not: every
failure sat at five to seven seconds against a default 5s timeout, because
fourteen jsdom environments are built in parallel and a loaded machine crosses
it. `testTimeout` is now 20s and eight consecutive full runs are clean.

Worth recording because the first diagnosis was wrong. The failure that surfaced
first pointed at a session leak in a test added the same hour, and there was a
plausible mechanism for it — so a fix was written for a cause that did not
exist. Only reading *all* the failures, rather than the first one, showed a flat
5–7 second band across four unrelated files, which is a timeout signature and
not a logic one. **Wall-clock times in a failure list are evidence; a plausible
story about the most recent change is not.**

## 32. Still open

### Blocked outside this repo

**Native verification.** Everything has been exercised on the web target, which
runs the same JS but does not prove native font loading, native SVG
rasterisation, or Reanimated on the UI thread. Needs an Expo Go run; the iOS
Simulator route is blocked until Xcode is installed.

**`BleSource`.** Implemented against the interface and documented, but throws
by design until the firmware telemetry contract exists. `USE_MOCK = false` is
the single switch and no screen file changes when it flips. The backend's
dispatcher throws for the same reason.

### Known and deliberate

**Invitation delivery.** No email, so an administrator hands the link over and
whoever holds an unused one can claim the account. Single use and a seven-day
expiry bound it; the console says so at the point of handover.

**SQLite.** `audit_events.seq` uses `MAX(seq) + 1`, which is not safe under
concurrent writers. Postgres wants `BIGSERIAL`; the note is beside the column.

**One BMS profile.** The capability-profile design means a second vendor is
another JSON file rather than a code change, but only JBD SP24S004 exists.

**Location.** Columns and a `location: null` field are reserved per PRD §7.16
so adding GPS needs no migration. Nothing populates them.

**Device identity is a User-Agent.** `device_label` names a signed-in device so
the eviction notice can say *which*. It is neither unique nor trustworthy — two
identical phones look the same, and a client can send anything. It exists to
make the notice readable, and nothing depends on it for identity.

**The sign-in cap covers the company-owner role only.** Technicians hold their
own seats and are bounded by `seat_limit` instead; capping them too would mean a
field user losing their tablet every time they picked up their phone.
`CAPPED_ROLES` is the one place to change if that turns out to be wrong.

## 33. Into git, and the first CI run

The project went to
[knowyourmechanic/KnowyourEV-app](https://github.com/knowyourmechanic/KnowyourEV-app)
as one commit. Two things were worth care rather than haste.

**`mobile/` was its own git repository.** It staged as a gitlink, which means a
clone of the outer repository would have contained an empty `mobile/` directory
and no way to obtain its contents — the push would have looked like it worked
and shipped a third of the project as a dangling pointer. Its history was a
single `create-expo-app` scaffold commit and every real change was uncommitted,
so flattening it lost nothing; its `.git` was moved aside rather than deleted,
because "nothing of value in here" is a judgement worth being able to reverse.

**What must not be committed.** `dev.db` holds real scrypt hashes for the seeded
accounts and `knowyourev.db` the same; both are covered by `*.db` in the root
`.gitignore`, along with `node_modules/`, build output, `.expo/`, and
`.claude/launch.json` — that last one names absolute paths on one machine and
would be actively misleading anywhere else. The staged set was checked for
databases, env files and keys before the commit, not after. The only credentials
in the tree are the throwaway ones in `verify.sh`, which exist to boot a
disposable database in a test run and are named so they cannot be mistaken for
anything else.

**CI had never run.** `.github/workflows/ci.yml` was written in §23 and, with no
git repository to run it, stayed correct-looking and unexecuted. Those are not
the same thing, and the README said so rather than implying a green badge. The
push is the first time it has actually been asked to do anything.
