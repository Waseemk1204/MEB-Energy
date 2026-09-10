# KnowyourEV — mobile app

Phase 1 field-user app: connect to a battery over BLE, read normalized telemetry,
and change BMS parameters through a governed safe-write flow.

Built against **Expo SDK 57** (React Native 0.86.3, React 19.2.3). All 13 screens
from PRD §10.1 are implemented. The transport is currently simulated — see
[Seams](#seams).

---

## Running it

```bash
npm install
npm start          # then press i / a / w
```

| Command | What it does |
|---|---|
| `npm start` | Metro dev server |
| `npm test` | Jest — 244 tests, 19 suites |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `expo lint` |

All three checks pass clean. Run them before pushing; the first is the only one
that catches a broken app, and even it has a blind spot (see [Route
integrity](#route-integrity)).

---

## Two flags you will want

Both live in [`src/config.ts`](src/config.ts) and
[`src/store/useTelemetryStore.ts`](src/store/useTelemetryStore.ts).

**`DEV_BYPASS_AUTH`** (default on in dev) — cold starts skip Login and link
`BAT-00042` automatically. It seeds only the *initial* session, so the real flow
stays walkable at any time via **Settings → Sign out**. It can never mask a
broken login path. Always false in a release build.

**`USE_MOCK`** (default `true`) — selects `MockSource` over `BleSource`. Flipping
it must not require touching a single screen file; that is the whole point of the
`TelemetrySource` interface.

---

## Architecture

```
app/                     expo-router routes — screens only, no tests (see below)
  _layout.tsx            providers, font loading, entry-flow guard
  (tabs)/                Dash · Cells · History · Settings
  write/[parameterKey]   the safe-write modal
src/
  theme/                 design tokens, type scale, ThemeProvider
  gauge/                 polar maths + the Gauge component
  ui/                    LeatherPanel, StitchBorder, primitives, StepList, PinPad
  telemetry/             TelemetrySource interface, MockSource, BleSource
  bms/                   capability profile + the JBD SP24S004 JSON
  store/                 zustand stores, secure storage, PIN
  navigation/            entryRoute — the entry-flow decision, as a pure function
__tests__/               screen tests (must NOT live under app/)
```

### Seams

Three places are deliberately swappable, and each has tests that would fail if a
change broke the seam.

**`TelemetrySource`** ([types.ts](src/telemetry/types.ts)) — the app and every
screen operate only on a normalized `BatterySnapshot`, never on vendor packet
formats. `MockSource` is a small physics model: a coulomb counter integrates pack
current against 100 Ah, and cell voltages ride a LiFePO4 OCV curve with a 0.4 mΩ
IR drop, so SOC, voltage and current move together the way hardware does. Random
walks on three independent needles look fake immediately.

**The capability profile** ([jbd-sp24s004.json](src/bms/jbd-sp24s004.json)) —
Settings, BMS Info and the write flow are generated from it. Deleting a parameter
from the JSON removes its row with no code change. A second BMS vendor ships as
another profile, not as branching in a screen.

**`entryRoute`** ([entryRoute.ts](src/navigation/entryRoute.ts)) — the PRD §7.4
flow as a pure function, separate from the navigation plumbing, so it can be
tested exhaustively rather than by driving the app.

### Gauge axes are derived, never literal

The reference mock shows a 400 V Tesla pack on a `0–450 V` axis. This is a 24S
LiFePO4 pack: on that scale the needle would sit pinned at the far left forever,
making the instrument decorative. `axes()` derives them from the profile —
`−400…+400 A` from the board's 200 A rating, `62…90 V` from cell count × the
protection thresholds, rounded to whole volts so the tick ladder lands exactly on
the arc end.

---

## Rules the code enforces

These come from the PRD and are enforced structurally, not by convention.

**A gauge is never the only representation of a value.** `<Gauge>` requires
`value` and always renders its readout. There is no `showValue` prop, and a test
asserts no such escape hatch exists. A needle position is an approximation; a
misread protection threshold is a fire risk.

**Critical writes are gated.** Value changed → acknowledgement → reason
(mandatory) → PIN if one is set. The primary button names the actual change
(`Write 3.800 V`), never "Confirm". Each gate has its own test so a regression
names the gate that broke.

**Admin remote writes are passive.** They reach the BMS without prompting the
user, so `PassiveChangeBanner` and the Activity timeline are the only way someone
stood next to a live pack learns it changed. The banner has no dismiss control by
design, and a test asserts it never grows one.

**Read-only parameters state why.** Over-current thresholds are fixed by the
board's continuous-current rating. They render with a `SKU-fixed` tag and are not
pressable — a dead disabled row reads as a bug, a stated reason reads as a fact.

**The Location section always renders.** PRD §7.16 reserves it; it shows
"Location unavailable — requires GPS-enabled hardware" until GPS hardware exists.
It looks like dead code and is easy to delete as cleanup — two tests stop that.

---

## Security posture

**The PIN is a deliberate-action gate, not authentication.** It stops a mistap
and stops someone picking up an unlocked phone on a bench. The real security
boundary is server-side policy enforcement (PRD §5.2 — UI hiding is never the
boundary), and nothing in the backend should trust it. It is stored salted and
hashed anyway, so a Keychain dump does not yield the digits.

**Sessions persist, BLE links do not.** `expo-secure-store` holds the session for
12 hours; a corrupt or expired record fails closed to signed-out and is purged.
`connectedBatteryId` is deliberately *not* persisted — a BLE link cannot survive
process death, and restoring one would open the Dashboard on live-looking gauges
for a pack the phone is no longer talking to. On relaunch you land on the Battery
List and re-link.

**`expo-secure-store` is native-only.** iOS and Android use Keychain/Keystore with
`WHEN_UNLOCKED_THIS_DEVICE_ONLY`. On web it falls back to `localStorage`, which is
**not** secure storage — web is a development surface here, and that fallback must
never hold a production token.

---

## Route integrity

expo-router turns **every file under `app/` into a route** and imports it into the
app bundle. A test file colocated there gets imported at runtime, where `describe`
and `expect` do not exist, and the app dies on a blank screen with
`ReferenceError: expect is not defined`.

Jest does not care where files live, so the whole suite stays green while the app
is completely broken. This happened during development with 191 tests passing.

[`__tests__/routes.test.ts`](__tests__/routes.test.ts) is the guard: it fails if
anything under `app/` is not a real route. **Screen tests live in `__tests__/`.**

---

## Testing notes

RNTL v14 changed two things that produce confusing failures:

- **`render` is async.** `const q = await render(...)`.
- **`fireEvent` is async.** Unawaited, tests asserting *initial* state pass while
  tests asserting *changed* state fail, and unflushed updates leak into the next
  test — so failures look like ordering bugs. `await fireEvent.press(...)`.

Reanimated 4's own Jest mock still loads the real `react-native-worklets` native
module and throws, so [`jest.setup.js`](jest.setup.js) provides a purpose-built
mock that resolves animations to their final value immediately.

Gauge tick labels are SVG: react-native-svg stores the string on
`RNSVGTSpan.props.content`, so `getByText` cannot see them. `Gauge.test.tsx` has a
walker for this — a silent false-negative trap otherwise.

---

## What is deliberately not done

**`BleSource` throws by design.** It implements the interface and documents the
wiring order, but the firmware telemetry contract does not exist yet. When it
does: connect, authenticate against the gateway's secure element, and **stop the
flow on auth failure before any read** — the app must never treat an unverified
peripheral as a KnowyourEV device.

**The auth token is a placeholder.** `signIn` mints `local-<timestamp>` because
there is no auth service. The storage shape, expiry check and fail-closed paths
are built for the real thing, so Phase 4 replaces the mint and adds refresh
without touching the seam or the guard.

**The `authenticate device` connect stage is a timed placeholder** — the real
challenge/response goes there, marked in [`useSessionStore.ts`](src/store/useSessionStore.ts).

**Gauge digits do not roll.** They render from state at the 2 Hz sample rate, so
they lag truth by zero. An animated counter would make the safety-critical half of
the instrument trail the real value. The spring stays on the needle and arc.

**History ranges are 30s/1m/2m**, not hours — that is what the live BLE session
buffer actually holds. Longer trends need the cloud telemetry history service, and
the screen says so rather than inventing data.

**Not yet verified on a device or simulator.** Everything has been exercised on
the web target, which runs the same JS but does not prove native font loading,
native SVG rasterisation, or Reanimated running on the UI thread. Those need an
Expo Go run.

**Untested:** the layout chrome (`ScreenScaffold`, `LeatherPanel`, `StitchBorder`)
— pure presentation with no logic. Everything else has coverage.
