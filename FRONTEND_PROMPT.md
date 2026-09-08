# knowyourEV — Complete Frontend Build Prompt

> Paste everything between the `═══` rules into your coding agent. It is self-contained: it does not require the PRD, the build plan, or the reference image to be attached, because every constraint from them is restated inline. Attach the reference mock anyway if your tool accepts images — it helps.

═══════════════════════════════════════════════════════════════════════════

You are building the **knowyourEV** mobile app frontend: a BMS diagnostics, configuration and fleet-management client for EV battery packs. Build it completely, in one pass, with live-updating instrumentation. Do not stub screens, do not leave TODOs, do not ask me to fill anything in.

## 1. Stack — use exactly this

- **Expo SDK 51+**, React Native, **TypeScript strict**
- `expo-router` (file-based routing, typed routes)
- `react-native-svg` — all gauges, charts and the stitch borders
- `react-native-reanimated` v3 — needle springs, digit rolls, banner
- `expo-linear-gradient` — leather gradients
- `expo-font` — Space Grotesk, Inter, Fraunces (via `@expo-google-fonts/*`)
- `zustand` — telemetry + settings store
- `lucide-react-native` — icons only where named below
- `react-native-ble-plx` — declared and wired behind an interface, but the app must run end-to-end on the mock source with zero BLE hardware

No UI kit. No NativeWind, no Tamagui, no React Native Paper. Every pixel is written here.

## 2. Non-negotiable product rules

These come from the product spec and override any aesthetic instinct:

1. **A gauge is never the only representation of a value.** Every gauge renders a precise numeric readout. The `<Gauge>` component must not expose any prop capable of hiding it. A needle position is an approximation; a misread protection threshold is a fire risk.
2. Any parameter with `danger_level: "Critical"` must appear as **text at ≥14pt with a coloured dot**, in addition to any graphical form.
3. **Monitoring and configuration are separate screens.** No inline editing on a monitoring screen. Ever.
4. Settings controls are **generated at runtime from a BMS capability profile JSON**. Zero vendor-specific branching in component code. Deleting a parameter from the JSON must remove its row with no code edit.
5. Admin-initiated remote changes are reflected **passively** — a non-blocking banner and a history entry. Never a modal, never an approval prompt, never anything requiring a dismissal tap.
6. Touch targets ≥ 44 × 44. Text contrast ≥ 4.5:1 in both themes.
7. The Location section exists on the Dashboard and displays *"Location unavailable — requires GPS-enabled hardware."* It is deliberately disabled, not omitted.

## 3. Design language — "Bentley cluster"

Luxury automotive instrument cluster, not flat SaaS. **Two materials, and they mean different things:**

- **Leather** (tan in light mode, black in dark mode, always with an inset dashed stitch line) = live primary instrumentation. Always pinned, never scrolls.
- **Cream matte panel** (off-white light / near-black dark) = data, lists, controls. Always scrolls.

Never mix them within one region. There is no third material.

**The stitch is the only border in the app.** A dashed line inset 9pt from every panel edge. No 1px card hairlines, no Material elevation shadows. Depth comes from the material change plus one soft ambient shadow under the cream panel only.

### 3.1 Tokens — implement verbatim in `src/theme/tokens.ts`

```ts
export const palette = {
  light: {
    leatherGradient: ['#D2B189', '#C09A6C', '#AD875A'] as const,
    leatherStitch:  '#EFE0C4',
    leatherInk:     '#24180A',
    leatherInkSoft: '#5B4526',
    leatherTrack:   '#E6D6BA',
    leatherNeedle:  '#F6EDDB',
    leatherHub:     '#3A2A17',

    panelBase:      '#FCFAF5',
    panelAlt:       '#F4EEE2',
    panelStitch:    '#E4D8C2',
    panelTrack:     '#E9DFCC',
    panelNeedle:    '#3A2A17',

    inkStrong:      '#241809',
    inkSoft:        '#6E5B44',
    inkFaint:       '#A8967C',

    accent:         '#8B6238',
    good:           '#4F7A4E',
    warn:           '#B5791D',
    critical:       '#A63B27',

    navPill:        '#43301A',
    navPillInk:     '#F6EDDB',
    navInactive:    '#A8967C',
    backdrop:       '#EDE4D3',
  },
  dark: {
    leatherGradient: ['#262019', '#1A1611', '#100D09'] as const,
    leatherStitch:  '#4B3E2C',
    leatherInk:     '#F3E9D9',
    leatherInkSoft: '#B39A72',
    leatherTrack:   '#33291D',
    leatherNeedle:  '#E8C088',
    leatherHub:     '#0E0B08',

    panelBase:      '#191510',
    panelAlt:       '#211C15',
    panelStitch:    '#362E22',
    panelTrack:     '#2E271D',
    panelNeedle:    '#E8C088',

    inkStrong:      '#F3E9D9',
    inkSoft:        '#B3A48A',
    inkFaint:       '#7A6B55',

    accent:         '#D6AD73',
    good:           '#8AC78E',
    warn:           '#DCA84E',
    critical:       '#E2775C',

    navPill:        '#D6AD73',
    navPillInk:     '#171310',
    navInactive:    '#6B6153',
    backdrop:       '#0A0908',
  },
} as const;

export const radii   = { hero: 0, panel: 28, card: 20, chip: 999 } as const;
export const space   = { gutter: 20, panel: 18, row: 14, grid: 4 } as const;
export const stitch  = { inset: 9, width: 2, dash: [6, 5] as const, opacity: 0.9 } as const;
```

### 3.2 Type scale — `src/theme/type.ts`

Two families only: **Space Grotesk** (numeric + titular) and **Inter** (prose + labels). `Fraunces 600` appears on exactly two screens (Login, Battery List) as the wordmark. **Every numeral uses `fontVariant: ['tabular-nums']`** — a needle may twitch, a digit column may not reflow.

| Token | Family / weight | Size | Letter-spacing | Transform |
|---|---|---|---|---|
| `heroValue`    | SpaceGrotesk_700 | `0.30 × gaugeSize` | −1.5 | — |
| `heroUnit`     | SpaceGrotesk_600 | `0.13 × gaugeSize` | 0 | — |
| `heroCaption`  | Inter_600 | `0.055 × gaugeSize` | +4 | UPPER |
| `metricValue`  | SpaceGrotesk_700 | 34 | −1 | — |
| `metricUnit`   | SpaceGrotesk_600 | 15 | 0 | — |
| `metricCaption`| Inter_600 | 10 | +1.6 | UPPER |
| `screenTitle`  | SpaceGrotesk_700 | 26 | −0.5 | UPPER |
| `screenSub`    | Inter_500 | 12 | +1.2 | UPPER |
| `sectionLabel` | Inter_700 | 11 | +2 | UPPER |
| `rowLabel`     | Inter_500 | 14 | 0 | — |
| `rowValue`     | SpaceGrotesk_600 | 14 | 0 | — |
| `tabLabel`     | Inter_600 | 10 | +0.8 | UPPER |
| `wordmark`     | Fraunces_600 | 30 | +0.2 | — |

## 4. File tree — create exactly this

```
app/
  _layout.tsx                 root: fonts, theme provider, telemetry provider
  login.tsx
  (tabs)/
    _layout.tsx               custom TabBar: DASH · CELLS · HISTORY · SETTINGS
    index.tsx                 Battery Dashboard
    cells.tsx
    history.tsx
    settings.tsx
  batteries.tsx               Battery List / Home
  protection.tsx
  bms-info.tsx
  device.tsx
  activity.tsx
  support-session.tsx
  help.tsx
  write/[parameterKey].tsx    Write Confirmation
src/
  theme/          tokens.ts  type.ts  ThemeProvider.tsx  useTheme.ts
  gauge/          polar.ts  Gauge.tsx  GaugeReadout.tsx  Needle.tsx  TickLadder.tsx
                  polar.test.ts
  ui/             LeatherPanel.tsx  StitchBorder.tsx  DataRow.tsx  SectionLabel.tsx
                  FactStrip.tsx  StatusChip.tsx  DangerDot.tsx  ScreenHeader.tsx
                  TabBar.tsx  PassiveChangeBanner.tsx  ConfirmSheet.tsx
  telemetry/      types.ts  TelemetrySource.ts  MockSource.ts  BleSource.ts
                  useTelemetry.ts
  bms/            capabilityProfile.ts  jbd-sp24s004.json  parameters.ts
  store/          useTelemetryStore.ts  useSettingsStore.ts  useActivityStore.ts
```

## 5. Gauge engine — the crux of the whole app

### 5.1 `src/gauge/polar.ts` — implement exactly

```ts
export const polar = (cx: number, cy: number, r: number, deg: number) => {
  const rad = (deg * Math.PI) / 180;           // 0° = 12 o'clock, clockwise positive
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
};

export const arcPath = (cx: number, cy: number, r: number, a0: number, a1: number) => {
  const s = polar(cx, cy, r, a0);
  const e = polar(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 >= a0 ? 1 : 0;
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} ${sweep} ${e.x} ${e.y}`;
};

export const angleFor = (v: number, min: number, max: number, a0: number, a1: number) => {
  const t = Math.min(1, Math.max(0, (v - min) / (max - min)));
  return a0 + t * (a1 - a0);
};
```

Write `polar.test.ts` asserting: `angleFor(50,0,100,-135,135) === 0`; `angleFor(0,0,100,-135,135) === -135`; a bipolar `angleFor(0,-400,400,-115,115) === 0` (zero sits at 12 o'clock); and that out-of-range values clamp rather than overshoot the arc.

### 5.2 `variant="hero"` — the big SOC dial

| Property | Value |
|---|---|
| Sweep | **−135° → +135°** (270°, opening at the bottom). `50` lands at 12 o'clock, `0` at ~7:30, `100` at ~4:30. |
| Size | `Math.min(screenWidth - 96, 268)` |
| Ring | `r = 0.40 × size`, stroke `0.055 × size`, `strokeLinecap: 'round'` |
| Track | `leatherTrack` |
| Value arc | `leatherNeedle` @ 0.55 opacity, sweepStart → current angle |
| Danger zone | 0–15 painted `critical` @ 0.45 opacity, drawn **under** the track |
| Major ticks | every 10 units (11 total), length `0.05 × size`, **outside** the ring, `leatherInkSoft`, 1.5px |
| Minor ticks | every 2 units, length `0.022 × size`, 1px, 0.5 opacity |
| Tick labels | **inside** the ring at `r - 0.115 × size`, Inter_500, `0.042 × size`, `leatherInkSoft` |
| Needle | tapered `<Polygon>`: width `0.030 × size` at the hub → `0.006 × size` at the tip; tip at `r - 0.045 × size`; fill `leatherNeedle`; add a 1px `rgba(0,0,0,0.28)` trailing edge so it stays visible over the light part of the gradient |
| Hub | `<Circle r={0.042 × size} fill={leatherHub} />` + inner dot `r={0.018 × size}` in `leatherNeedle` |
| Centre | value `heroValue` + unit `heroUnit` baseline-aligned, caption `heroCaption` below, block centred at `cy - 0.09 × size` |

### 5.3 `variant="metric"` — Pack Current / Pack Voltage

| Property | Value |
|---|---|
| Layout | **value + unit ABOVE the arc**, caption below the arc. The value is never inside the ring on this variant. |
| Sweep | **−115° → +115°** (230°) |
| Size | `152` |
| Ring | `r = 0.40 × size`, stroke `0.05 × size` |
| Ticks | 7 major with labels inside the ring, no minor ticks |
| Bipolar axes | Pack Current is signed: `0` at 12 o'clock, negatives sweep left. Paint the value arc **from the zero angle**, not from sweepStart. |
| Centre glyph | `Zap` (current) / `BatteryMedium` (voltage), `0.11 × size`, `accent` @ 0.7 |
| Needle | as hero but `panelNeedle`, hub `0.034 × size` |

### 5.4 `variant="strip"` — 44 × 44 inline dial

Arc only. No needle, no ticks, no hub. The numeric value is printed beside it by the parent row.

### 5.5 Axis ranges — derive, never hardcode

```ts
packCurrent: { min: -2 * continuousCurrentA, max: 2 * continuousCurrentA, tick: 100 }
packVoltage: { min: cellCount * uvpReleaseV,  max: cellCount * ovpV,      tick: 4   }
soc:         { min: 0,   max: 100, tick: 10, dangerZone: [0, 15] }
temperature: { min: -20, max: 90,  tick: 10, warnAt: 75, criticalAt: 90 }
```

For the seeded JBD SP24S004 24S/200A profile that yields **Current −400…+400 A** and **Voltage 62.4…90.0 V**. If you have seen the reference mock: it shows a 400 V Tesla pack with a `0–450 V` axis. Do **not** copy that axis. Copy the composition; a 24S LiFePO4 pack on a 0–450 scale would leave the needle pinned at the far left permanently, which defeats the instrument.

### 5.6 Motion

- **Needle:** one shared Reanimated `SharedValue` per gauge driving both needle rotation and value arc, animated with `withSpring({ damping: 14, stiffness: 90, mass: 0.6 })`. A real instrument needle overshoots ~4% and settles in ≈650 ms. Do not use `withTiming` — a linear needle reads as a progress bar and kills the whole effect.
- **Digits:** `withTiming(180)` rolling counter, clamped so the displayed number is never more than 250 ms behind truth.
- **Theme switch:** 320 ms cross-fade of the leather gradient only; text swaps instantly.
- **Screen transitions:** horizontal slide 260 ms, `Easing.out(Easing.cubic)`.
- **Reduce Motion:** when `AccessibilityInfo.isReduceMotionEnabled()` is true, needles jump instantly and digits do not roll.

## 6. Real-time telemetry — build this before any screen but the Dashboard

### 6.1 `src/telemetry/types.ts`

```ts
export interface BatterySnapshot {
  timestamp: number;
  soc: number;                 // %
  packVoltage: number;         // V
  packCurrent: number;         // A, + = charging, − = discharging
  temperatures: number[];      // °C, from the two NTC probes
  cellVoltages: number[];      // V, length = cellCount
  cellCount: number;
  minCellV: number; maxCellV: number; deltaMv: number;
  chargeMos: boolean; dischargeMos: boolean;
  balancing: boolean; balancingCells: number[];
  faults: Array<{ code: string; label: string; level: 'Warning' | 'Critical'; detail?: string }>;
  cycles: number;
  soh: number;                 // %
  bmsModel: string; bmsFirmware: string;
  bleState: 'connected' | 'connecting' | 'disconnected';
  location: null;              // reserved — always null until GPS hardware exists
}

export interface TelemetrySource {
  start(onSnapshot: (s: BatterySnapshot) => void): void;
  stop(): void;
  readSetting(key: string): Promise<number>;
  writeSetting(key: string, value: number): Promise<{ ok: boolean; readBack?: number; error?: string }>;
}
```

### 6.2 `MockSource` — this is what makes the app feel live

Emit a snapshot **every 500 ms (2 Hz)**. It must be a small physics simulation, not `Math.random()` noise, or the needles will jitter meaninglessly:

- Maintain a coulomb counter. `soc` integrates `packCurrent` over time against a 100 Ah nominal capacity.
- Cycle a duty pattern every ~40 s: **discharge** (−120 A drifting ±25), **idle** (≈0 A), **charge** (+80 A tapering as SOC → 100).
- `packVoltage = sum(cellVoltages)`, where each cell sits on a LiFePO4 OCV curve for the current SOC plus an IR drop of `packCurrent × 0.4 mΩ` and a small per-cell offset. This makes voltage and current move together the way a real pack does — the single detail that sells the instrument.
- Cell spread widens slowly toward ~40 mV, then narrows when `balancing` engages above 3.40 V (the seeded balance turn-on voltage).
- Temperature drifts with |current|, 22 → 34 °C.
- Inject a `Cell OVP` warning fault once per demo cycle when any cell exceeds 3.750 V, and clear it — so the Protection screen is provably alive.
- Seed the RNG so runs are reproducible.

`BleSource` implements the identical interface over `react-native-ble-plx`, subscribing to the gateway's notify characteristic and parsing normalized frames. **Swapping the two must not touch a single screen file.** Write it, guard it behind a `USE_MOCK` flag defaulting to `true`, and make sure the app runs fully with no hardware present.

## 7. BMS capability profile — `src/bms/jbd-sp24s004.json`

Every parameter carries: `parameter_key, display_name, unit, data_type, min, typ, max, danger_level (Normal|Warning|Critical), group, readable, writable, requires_confirmation, requires_admin`.

Seed these real vendor-datasheet values — not placeholders:

**Voltage Protection** — Cell OVP `3.700 / 3.750 / 3.800 V` · OVP Delay `1000 / 2000 / 3000 ms` · OVP Release `3.550 / 3.600 / 3.650 V` · Cell UVP `2.100 / 2.200 / 2.300 V` · UVP Delay `1000 / 2000 / 3000 ms` · UVP Release `2.500 / 2.600 / 2.700 V`

**Current Protection** (24S, 200 A SKU — `writable: false`, these are fixed by the board's continuous-current rating) — Charge OCP `220 ± 5 A` · 1st-stage Discharge OCP `220 ± 5 A` · 2nd-stage Discharge OCP `600 ± 50 A` · Short-circuit `2400 ± 400 A` · Charge OCP delay `5 / 10 / 15 s` · 1st-stage delay `5 / 10 / 15 s` · 2nd-stage delay `32–500 ms` · Short-circuit delay `62–1000 µs`

**Temperature** — Charge HTP `62 / 65 / 68 °C` · Charge HTP release `52 / 55 / 58 °C` · Charge LTP `−13 / −10 / −7 °C` · Charge LTP release `−8 / −5 / −2 °C` · Discharge HTP `72 / 75 / 78 °C` · Discharge HTP release `62 / 65 / 68 °C` · Discharge LTP `−23 / −20 / −17 °C` · Discharge LTP release `−13 / −10 / −7 °C` · FET HTP `85 / 90 / 95 °C` · FET HTP release `65 / 70 / 75 °C`

**Balancing** — Balance turn-on `3.37 / 3.40 / 3.43 V` · Balance opening delta `15 mV` · Balance current `20–110 mA`

**System / BMS** — model `JBD SP24S004`, cell count `24`, UART `9600 8N1`, continuous rating `200 A`

All voltage/temperature/OVP/UVP parameters are `danger_level: "Critical"` except the release thresholds and balancing (`Normal`), and the temperature protections (`Warning`).

## 8. Screens — build all thirteen

Each spec below names its **material split** first. That split *is* the design language.

**1 · Login** — Full-bleed leather, no cream panel. Fraunces wordmark centred at 38% height, two stitched inputs with 60%-opacity cream fills, one solid `navPill` CTA. Version + supported-BMS line in `inkFaint` at the base. No gauges.

**2 · Battery List / Home** — Leather header strip 140pt → cream body. One `LeatherPanel` card per battery: battery ID, chemistry + cell count, a `strip` SOC dial with the percentage printed beside it, and a BLE chip (`Connected` good / `In range` warn / `Offline` neutral). Tapping runs Connect → Authenticate Device → Detect BMS → Dashboard, showing each step.

**3 · Battery Dashboard** — the hero screen. Reproduce the reference mock's composition exactly:
- *Leather hero panel*, bleeding to the top edge, ending at ~48% height: `ScreenHeader` with company name (large, uppercase) over battery ID + chemistry (small, letterspaced), and on the right an SOC chip with a battery glyph plus a `CYCLES 142` line. Below it, the `hero` SOC gauge, centred.
- *Cream panel*, radius 28 on the top corners only, hard seam against the leather: a row of two `metric` gauges — **Pack Current** and **Pack Voltage** — then a `panelStitch` hairline, then a 3-cell `FactStrip`: `Battery Health 96% (Good)` · `Temp 24 °C / 75 °F` · `Charging Not Charging`.
- *Below the fold*: cell-delta card (min/max mV + delta bar), MOS + balancing row, protection summary (`No active faults` or N faults in `critical`), the **Location card** with the required placeholder text and a dimmed map glyph, and `PassiveChangeBanner` when an admin write has landed.

**4 · Cells** — Thin leather header → cream body. 3-column grid of stitched cards: `CELL 07` over `3.412`. Min and max cells get a 1.5px `accent` inset ring and a `MIN`/`MAX` caption. Pinned summary bar shows `Δ 38 mV`, turning `warn` above the 15 mV balance-delta threshold. No needles — detail data stays tabular.

**5 · Protection** — Cream, list only. Three groups: **Active Faults**, **MOS State**, **Balancing**. Faults are full-width `critical` stitched cards printing the triggering value (`Cell OVP · Cell 14 · 3.771 V · limit 3.750 V`). Clean state is one calm `good` card. MOS renders as two large ON/OFF tiles.

**6 · BMS Information** — Cream, list only. Model, firmware, `24S`, `200 A` continuous, protocol `UART 9600 8N1`, plus a **capability matrix**: every `parameter_key` with readable / writable / requires_admin ticks.

**7 · Settings** — Cream, list only. Five `SectionLabel` groups rendered **from the capability profile**: Voltage Protection · Current Protection · Temperature · Balancing · System/BMS. Each `DataRow` = `DangerDot` + display name + current value + chevron. `writable: false` rows show no chevron, sit at 60% opacity, and carry a `SKU-fixed` chip (the over-current values are fixed by the board's current rating — render them as informational, not as a broken disabled control).

**8 · Write Confirmation** (`app/write/[parameterKey].tsx`) — **Leather bottom sheet** over a dimmed cream screen; the only modal that uses leather, to mark it as consequential. Order exactly: current value → new value (stepper + numeric keypad) → live type/range/support validation → safety warning sized by `danger_level` → explicit acknowledgement toggle → **reason field, mandatory when `danger_level` is Critical** → optional PIN/re-auth → Execute. The primary button stays disabled until every gate passes and is labelled with the actual change (`Write 3.700 V`), never `Confirm`. Execution shows three sequential ticks: write → read back → audit. Critical parameters change the sheet's own stitch colour to `critical`.

**9 · Activity / Passive Change Indicator** — Cream timeline, reverse-chronological: parameter, old → new, actor, and a **source badge** — `Local` / `Admin remote` / `Admin Force Push`. Admin-sourced entries get an `accent` left rail; Critical-level admin changes get a `critical` rail. On the Dashboard this appears as `PassiveChangeBanner`: it appears, never blocks, requires no dismissal, auto-collapses after 10 s, and remains in the timeline.

**10 · Support Session** — Leather header with a pulsing `accent` dot → cream body. Session ID, admin name, start time, running action list. Closes with the plain-language guarantee: *"An administrator can only reach this battery while your Bluetooth session is active."* Read-only — there is deliberately no approve/deny control.

**11 · Device** — Cream, list only. Device ID `KYE-000184`, hardware revision, firmware, last seen, and a **Security Status** row that is `good` only when device authentication passed and `critical` otherwise, with the connection blocked in that state.

**12 · History** — Thin leather header → cream body. Segmented control `SOC · Voltage · Current · Temp`, range chips `1H / 24H / 7D`. One stitched chart card: `accent` sparkline over three `panelTrack` gridlines, and a **scrubber that prints the exact value and timestamp** at the touch point. Charts obey the gauge rule: no value without a number.

**13 · Help** — Cream, accordion, safety-first order: what a critical parameter change can do → BLE troubleshooting → what the audit log records → support contact.

**Tab bar** — 4 tabs only: `DASH · CELLS · HISTORY · SETTINGS`. Active tab is a filled `navPill` rounded rectangle behind the icon with the label beneath in `tabLabel`; inactive tabs are bare icons in `navInactive`. Protection, BMS Info, Device, Support Session and Help are reached from Dashboard rows, not from the tab bar.

## 9. Build order — follow it

1. Theme + tokens + `LeatherPanel` + `StitchBorder` + fonts. Prove both themes on a throwaway screen **before** writing any gauge.
2. `polar.ts` + its tests.
3. `Gauge` — all three variants, static values.
4. Telemetry provider + `MockSource` → Dashboard live at 2 Hz. **This is the milestone that makes it real-time.**
5. Cells / Protection / BMS Info / Device / History off the same store.
6. Settings from the capability profile → Write Confirmation → Activity.
7. Login / Battery List / Support Session / Help.
8. `BleSource` behind the flag.

## 10. Do not

- Do not put gauges on list screens, or more than one hero gauge on any screen.
- Do not use card borders or Material shadows — the stitch is the only border.
- Do not introduce a third font family.
- Do not animate a needle with a linear tween.
- Do not hardcode the voltage axis to the mock's `0–450`.
- Do not hardcode Settings rows — they come from the capability profile JSON.
- Do not let a Critical value appear as a needle alone.
- Do not let a leather panel scroll, or a cream panel be pinned.
- Do not add an approval prompt or dismissible alert for admin remote writes.
- Do not omit the Location card.

## 11. Done means

- [ ] Dashboard matches the reference composition at 375 × 812 and 430 × 932.
- [ ] Both themes ship; every text/background pair ≥ 4.5:1.
- [ ] No prop anywhere can hide a gauge's numeric readout.
- [ ] Needle spring settles ≤ 700 ms; digits never lag truth by > 250 ms.
- [ ] 2 Hz telemetry with no dropped frames; SOC, voltage and current move together as a coherent physical system.
- [ ] Deleting a parameter from `jbd-sp24s004.json` removes its Settings row with zero code changes.
- [ ] Write Confirmation cannot complete with an empty reason on a Critical parameter.
- [ ] The Location card is present with the exact placeholder string.
- [ ] Reduce Motion disables needle springs and digit rolls.
- [ ] `USE_MOCK = false` compiles and touches no screen file.
- [ ] `tsc --noEmit` and `expo lint` both pass clean.

Build it now, in full.

═══════════════════════════════════════════════════════════════════════════

## Using this prompt

**In Claude Code / Cursor / an agentic IDE:** paste it as the first message in an empty directory. Expect it to run long; if your tool caps output, split at the `## 9. Build order` heading and issue steps 1–4 first (that gets you a live Dashboard), then steps 5–8.

**In v0 / Lovable / Bolt:** these are web-first. Either request the React Native Web output, or swap §1 for `Vite + React + TypeScript`, `svg` in place of `react-native-svg`, and CSS transitions in place of Reanimated — §§2, 3, 5, 7, 8, 10 and 11 transfer unchanged, since they are stack-independent.

**Iterating afterwards:** quote the specific clause you want changed (e.g. *"§5.2, change the hero sweep to −120°/+120°"*). The prompt is numbered so a follow-up can target one rule without re-deriving the rest.
