# KnowyourEV — Mobile UI Plan
### "Bentley Cluster" design language · React Native (Expo) · all 13 screens

**Source of truth:** KnowyourEV PRD v1.0 (§7.4 Mobile App, §7.5 Safe Write, §7.16 Location Readiness, §7.17 Visual Design Language, §10.1 Screens) and KnowyourEV App Build Plan v1.0 (Phase 1 — User MVP).

**Reference image:** the tan stitched-leather instrument cluster mock. Everything below is measured against it.

---

## 0. What the reference image actually specifies

Read literally, the mock encodes eight decisions. The rest of this plan is those eight decisions propagated to every screen.

| # | Decision in the image | Rule it becomes |
|---|---|---|
| 1 | Top ~48% is warm tan leather with a stitched inset border; bottom is clean cream | **Two-material rule**: leather = live/primary instrumentation, cream = data & controls. Never mix. |
| 2 | One dominant circular gauge, 270° sweep, needle + tick ladder | **One hero per screen.** Exactly one gauge may be hero-sized. |
| 3 | The number `72%` lives *inside* the ring and is the largest element on screen | **Digits outrank the needle.** The needle is decoration on top of truth. |
| 4 | Secondary gauges put the digital value *above* the arc, not inside | **Secondary pattern**: value → arc → caption, vertically stacked. |
| 5 | Everything is a rounded rectangle with a 9px inset dashed stitch line | **Stitch is the only border.** No 1px hairline card borders anywhere. |
| 6 | A flat 3-column status strip (`Battery Health / Temp / Charging`) closes the content | **Terminal strip**: every screen ends with a 2–3 cell fact strip, no gauges. |
| 7 | Tab bar: active tab is a filled dark-brown pill, inactive are bare icons | **Single active pill**, uppercase 10px labels, 4 tabs max. |
| 8 | Type is one grotesk at two weights; no serif, no icon noise | **Two families total.** Numerals tabular, labels letterspaced uppercase. |

**The one deviation you must make.** The mock shows a 400 V Tesla pack (`392.4 V`, axis `0–450`). KnowyourEV Phase 1 targets a **JBD SP24S004, 24S LiFePO4** pack: nominal 76.8 V, real operating band ≈ 60–88 V, 200 A continuous. Keep the *composition* of the mock; drive the *axis* from `BMSParameterDefinition.min/max`. Hardcoding `0–450` makes the needle sit dead at the far left for every real pack — the gauge would be decorative and, per PRD §7.17's safety note, that is exactly the failure mode to avoid.

---

## 1. Design tokens

Two themes, identical structure. Dark mode is black leather (PRD §7.17), not "dark grey UI".

### 1.1 Colour

```
                              LIGHT (Tan Leather)      DARK (Black Leather)
leather.gradient      165°    #D2B189 → #C39D71        #262019 → #1A1611
                              → #B58F62                 → #100D09
leather.stitch                #EFE0C4                  #4B3E2C
leather.inkStrong             #24180A                  #F3E9D9
leather.inkSoft               #3A2B19                  #B39A72
leather.track                 #E6D6BA                  #33291D
leather.needle                #F6EDDB                  #E8C088
leather.hub                   #3A2A17                  #0E0B08

panel.base                    #FCFAF5                  #191510
panel.alt                     #F4EEE2                  #211C15
panel.stitch                  #E4D8C2                  #362E22
panel.track                   #E9DFCC                  #2E271D
panel.needle                  #3A2A17                  #E8C088

ink.strong                    #241809                  #F3E9D9
ink.soft                      #6E5B44                  #B3A48A
ink.faint                     #776B58                  #8F826F

accent                        #8B6238                  #D6AD73
status.good                   #4D764C                  #8AC78E
status.warn                   #936217                  #DCA84E
status.critical               #A63B27                  #E2775C

nav.pill                      #43301A                  #D6AD73
nav.pillInk                   #F6EDDB                  #171310
nav.inactive                  #7F715E                  #867E73
screen.backdrop               #EDE4D3                  #0A0908
```

Contrast — **measured, not estimated**. `mobile/src/theme/contrast.test.ts` enforces these on every run:

| pairing | light | dark |
|---|---|---|
| `inkStrong` on `panelBase` | 16.6:1 | 15.1:1 |
| `inkSoft` on `panelBase` | 6.2:1 | 7.4:1 |
| `inkFaint` on `panelAlt` | 4.5:1 | 4.5:1 |
| `leatherInk` on darkest leather | 5.8:1 | 15.0:1 |
| `leatherInkSoft` on darkest leather | 4.6:1 | 6.7:1 |

An earlier draft of this plan quoted those figures from estimate and claimed every pairing passed 4.5:1. Five did not — `inkFaint`, `navInactive`, `warn`, `good` and `leatherInkSoft`. Those tokens were corrected, and the light leather gradient was lightened slightly at its dark end so soft ink clears the bar everywhere without collapsing into strong ink.

`leather.needle` is a graphic, not text, so it is held to the 3:1 non-text bar — the number inside the ring carries the meaning.

**Colour is never the only channel.** `good` and `warn` sit at almost identical luminance in the light theme, so a colour-blind or monochrome viewer cannot separate them by hue. `DangerDot` therefore announces its level, `DataRow` folds severity into its accessibility label, and `StatusChip` always renders text alongside its colour.

### 1.2 Type

Two families. `Space Grotesk` for anything numeric or titular; `Inter` for prose and labels.

| Role | Family / weight | Size | Tracking | Notes |
|---|---|---|---|---|
| `hero.value` | Space Grotesk 700 | 0.30 × gauge size | −1.5 | tabular-nums, inside ring |
| `hero.unit` | Space Grotesk 600 | 0.13 × gauge size | 0 | baseline-aligned to hero.value |
| `hero.caption` | Inter 600 | 0.055 × gauge size | +4 | uppercase, e.g. `SOC` |
| `metric.value` | Space Grotesk 700 | 34 | −1 | secondary gauge digits |
| `metric.unit` | Space Grotesk 600 | 15 | 0 | |
| `metric.caption` | Inter 600 | 10 | +1.6 | uppercase |
| `screen.title` | Space Grotesk 700 | 26 | −0.5 | uppercase in header, like `TESLA` |
| `screen.sub` | Inter 500 | 12 | +1.2 | uppercase, `ink.soft` |
| `section.label` | Inter 700 | 11 | +2 | uppercase, `ink.faint` |
| `row.label` | Inter 500 | 14 | 0 | |
| `row.value` | Space Grotesk 600 | 14 | 0 | tabular-nums |
| `tab.label` | Inter 600 | 10 | +0.8 | uppercase |
| `wordmark` | Fraunces 600 | 30 | +0.2 | Login & Battery List only |

**Every numeral is tabular.** A needle that twitches is instrumentation; a digit column that reflows is a bug.

### 1.3 Geometry & spacing

- Grid: **4pt**. Screen gutter **20**, panel inner padding **18**.
- Radii: hero leather panel `0` (bleeds to screen edges, top corners follow the device), cream panel `28` top-only, cards `20`, chips `999`.
- **Stitch:** dashed line inset **9pt** from every panel edge, `2px` dash, `6/5` dash/gap, radius = panelRadius − 9, opacity 0.9. This is the single unifying device across all 13 screens.
- Elevation: no Material shadows. Depth comes from material change (leather→cream) and from one soft ambient shadow on the cream panel only: `y 8, blur 24, rgba(60,40,15,0.10)`.
- Touch targets ≥ **44 × 44** (PRD §8, ui_plan §6), **declared explicitly** rather than left to content plus padding — `mobile/__tests__/touchTargets.test.tsx` audits every control on every screen. An earlier draft asserted this without checking; the History segmented control (40), its range chips (36) and the Back control (~42 with hitSlop) were all under the bar and have been corrected. Gauges are *not* touch targets; a tap anywhere on a gauge opens its numeric detail sheet.

---

## 2. Gauge anatomy (the crux)

Three variants, one maths core. All are SVG (`react-native-svg`), all animate with a spring, none is ever the only representation of a value.

### 2.1 Shared polar maths

```
polar(cx, cy, r, deg)  →  { x: cx + r·sin(rad), y: cy − r·cos(rad) }   // 0° = 12 o'clock
arc(cx, cy, r, a0, a1) →  "M …  A r r 0 large sweep …"
angleFor(v, min, max)  →  sweepStart + clamp01((v−min)/(max−min)) · (sweepEnd − sweepStart)
```

### 2.2 Variant HERO — State of Charge

Matches the mock's big dial exactly.

| Property | Value |
|---|---|
| Sweep | **−135° → +135°** (270°, opening at bottom). Verified against the mock: `50` sits at 12 o'clock, `0` at ~7:30, `100` at ~4:30. |
| Size | `min(screenWidth − 96, 268)` |
| Ring radius | `0.40 × size`, stroke `0.055 × size` |
| Track | `leather.track`, `strokeLinecap: round` |
| Value arc | `leather.needle` at 55% opacity, from sweepStart to current angle |
| Danger zone | 0–15% painted `status.critical` at 45% opacity, *under* the track |
| Major ticks | every 10 units — 11 ticks, length `0.05 × size`, outside the ring, `leather.inkSoft`, 1.5px |
| Minor ticks | every 2 units, length `0.022 × size`, 1px, 50% opacity |
| Tick labels | inside the ring at `r − 0.115 × size`, Inter 500, `0.042 × size`, `leather.inkSoft` |
| Needle | tapered polygon: hub width `0.030 × size` → tip width `0.006 × size`, tip at `r − 0.045 × size`, fill `leather.needle`, plus a `rgba(0,0,0,0.28)` 1px trailing edge so it reads on the light part of the gradient |
| Hub | circle `r = 0.042 × size`, `leather.hub`, with a `0.018 × size` `leather.needle` inner dot |
| Centre stack | `72` + `%` + `SOC`, vertically centred at `cy − 0.09 × size` |

### 2.3 Variant METRIC — Pack Current, Pack Voltage

Matches the mock's two lower dials.

| Property | Value |
|---|---|
| Layout | **value+unit above**, arc below, caption underneath — never the value inside |
| Sweep | **−115° → +115°** (230°) |
| Size | `152` (two per row at 375pt width) |
| Ring | `r = 0.40 × size`, stroke `0.05 × size` |
| Ticks | 7 major, labelled inside the ring in two visual columns as in the mock |
| Signed axes | Pack Current is bipolar: `0` sits at 12 o'clock, negative sweeps left. Paint the value arc **from 0**, not from sweepStart. |
| Centre glyph | `Zap` for current, `BatteryMedium` for voltage, `0.11 × size`, `accent` @ 70% |
| Needle | as HERO but `panel.needle`, hub `0.034 × size` |

**Axis ranges — drive from metadata, never literals.**

```
Pack Current   −(2 × I_cont) … +(2 × I_cont)      // SP24S004 200A SKU → −400…+400, ticks 100
Pack Voltage   cells × UVP_release … cells × OVP  // 24S → 62.4…90.0 V, ticks 4
SOC            0 … 100
Temperature    −20 … 90 °C  (Discharge-HTP 75 °C and FET-HTP 90 °C marked as warn/crit zones)
```

### 2.4 Variant STRIP — inline mini gauge

A 44 × 44 arc-only dial with no needle and no ticks, used in list rows (Battery List, Cells, Admin-style rows). Value always printed beside it.

### 2.5 Motion

| Element | Behaviour |
|---|---|
| Needle | `withSpring({ damping: 14, stiffness: 90, mass: 0.6 })` — a real needle overshoots ~4% then settles in ≈650 ms. Do **not** use a linear tween; it looks like a progress bar. |
| Value arc | same spring, driven off the same shared value so arc and needle never separate |
| Digits | `withTiming(180ms)` on a rolling counter, **but** the counter is clamped so the displayed number is never more than 250 ms behind truth |
| Theme switch | 320 ms cross-fade of the leather gradient only; text swaps instantly |
| Screen transition | horizontal slide 260 ms, `Easing.out(cubic)` |
| Reduce Motion | when `AccessibilityInfo.isReduceMotionEnabled()`, needles jump instantly and digits do not roll |

### 2.6 The safety rule that overrides all of the above

> PRD §7.17: *a gauge's needle position is an approximation by nature. Every gauge must carry a precise numeric readout alongside or on tap.*

Enforce it in code, not in review: `<Gauge>` **requires** a `value: number` and renders its `<GaugeReadout>` unconditionally. There is no `showValue={false}` prop. Any parameter with `danger_level: "Critical"` additionally renders its numeric value in `Space Grotesk 600` at ≥14pt with a `status.critical` dot — never as a gauge alone, ever.

---

## 3. Component inventory

Build these before any screen. Twelve primitives cover all 13 screens.

| Component | Purpose |
|---|---|
| `<LeatherPanel tone="hero \| panel \| alt">` | Gradient/flat background + inset dashed stitch. The base of everything. |
| `<Gauge variant="hero \| metric \| strip">` | Section 2. |
| `<GaugeReadout>` | Value + unit + caption; the enforced numeric half of every gauge. |
| `<FactStrip>` | The 2–3 cell terminal strip (`Battery Health / Temp / Charging`). |
| `<DataRow label value danger?>` | Left label, right tabular value, optional danger dot. The workhorse of Cells/Protection/BMS Info/Settings. |
| `<SectionLabel>` | 11pt letterspaced uppercase group heading. |
| `<StatusChip tone="good \| warn \| critical \| neutral">` | Pill; also the battery-% chip in the header. |
| `<DangerDot level>` | 7px dot, Normal/Warning/Critical. |
| `<ScreenHeader title sub right?>` | The `TESLA / MODEL S PLAID / 72% / RANGE` block, generalised. |
| `<TabBar>` | 4 tabs, active filled pill. |
| `<PassiveChangeBanner>` | Non-blocking admin-write indicator (PRD §6.3 step 8). |
| `<ConfirmSheet>` | The safe-write modal (PRD §6.2). |

---

## 4. Screen-by-screen

All 13 rows of PRD §10.1. Each screen states its **material split**, because that is the design language.

### 4.1 Login
*Full-bleed leather, no cream panel.* Fraunces wordmark centred at 38% height, two stitched input fields with cream fills at 60% opacity, one solid `nav.pill` CTA. Version + BMS-support line in `ink.faint` at the base. No gauges.

### 4.2 Battery List / Home
*Leather header strip (140pt) → cream body.* Header: wordmark + company name. Body: one `LeatherPanel` card per battery — battery ID, chemistry/cell count, a `STRIP` SOC dial with `72%` printed beside it, and a BLE state chip (`Connected` good / `In range` warn / `Offline` neutral). PRD §5.3: list is scoped to the user's own company. Tapping connects → Authenticate Device → Detect BMS → Dashboard.

### 4.3 Battery Dashboard — the reference screen
The mock, verbatim:

1. **Leather hero panel** (bleeds to top edge, ends ~48% height)
   - `ScreenHeader`: company name (`TESLA` slot) + battery ID/chemistry (`MODEL S PLAID` slot); right: SOC chip + `RANGE / CYCLES` line.
   - `Gauge variant="hero"` for **SOC**, centred, 0–100, 0–15% danger zone.
2. **Cream panel** (radius 28 top corners, overlaps the leather by 0 — a hard material seam, as in the mock)
   - Row of two `Gauge variant="metric"`: **Pack Current** (−400…+400 A) and **Pack Voltage** (62.4…90.0 V).
   - Hairline divider (`panel.stitch`).
   - `FactStrip`: `Battery Health 96% (Good)` · `Temp 24 °C / 75 °F` · `Charging Not Charging`.
3. **Below the fold** (scroll)
   - Cell delta card: min/max cell mV + delta with a horizontal bar.
   - MOS + balancing state row (Charge MOS / Discharge MOS / Balancing).
   - Protection summary: `No active faults` or N faults in `status.critical`.
   - **Location section — required by PRD §7.16.** Reserved card reading *"Location unavailable — requires GPS-enabled hardware"* with a dimmed map glyph. Ship it disabled, do not omit it.
   - `PassiveChangeBanner` when an admin write landed this session.
4. **TabBar**: `DASH · CELLS · HISTORY · SETTINGS`.

> The mock's `DRIVE / CHARGING` tabs are a Tesla artefact — KnowyourEV has no drive data. Keep the mock's tab *styling*, use KnowyourEV's information architecture. Protection, BMS Info, Device and Help are reached from Dashboard rows, not from the tab bar (4-tab maximum keeps the pill legible).

### 4.4 Cells
*Thin leather header → cream body.* 3-column grid of stitched cards, one per cell, `CELL 07 / 3.412`. Min and max cells get a 1.5px `accent` inset ring and a `MIN`/`MAX` caption. A pinned summary bar shows `Δ 38 mV` against the 15 mV balance-delta seed — over threshold turns it `status.warn`. Optional bar-chart toggle. No needles: per PRD §7.17 detail data stays tabular.

### 4.5 Protection
*Cream, list-only.* Three `SectionLabel` groups — **Active Faults**, **MOS State**, **Balancing**. Faults render as full-width `status.critical` stitched cards with the triggering value printed (`Cell OVP · Cell 14 · 3.771 V · 3.750 V limit`). Clean state is a single calm `status.good` card. MOS: Charge/Discharge as two large ON/OFF tiles.

### 4.6 BMS Information
*Cream, list-only.* Model `JBD SP24S004`, firmware, cell count `24S`, continuous rating `200 A`, protocol, and a **capability matrix** — every `parameter_key` with readable/writable/`requires_admin` ticks. This screen is what makes the vendor-neutral claim visible (PRD §7.11).

### 4.7 Settings
*Cream, list-only.* Monitoring and configuration are **separated** (PRD §7.4). Five groups, generated from the capability profile — never hardcoded:
`Voltage Protection` · `Current Protection` · `Temperature` · `Balancing` · `System / BMS`.
Each `DataRow` = `DangerDot` + display name + current value + chevron. Rows where `writable: false` show no chevron and sit at 60% opacity. Over-current rows are **read-only** — they are fixed by the board's continuous-current SKU (PRD §7.5), so render them with a `SKU-fixed` chip rather than a disabled control that looks broken.

### 4.8 Write Confirmation
*Leather bottom sheet over a dimmed cream screen* — the only place leather is used for a modal, to mark it as consequential. Ordered exactly as PRD §6.2:
`Current value → New value (stepper + keypad) → Range/type/support validation → Safety warning sized by danger_level → explicit acknowledgement toggle → Reason field (mandatory when Critical) → optional PIN/re-auth → Execute`.
The primary button is disabled until every gate passes, and it is labelled with the actual change (`Write 3.700 V`), never `Confirm`. Execution shows write → read-back → audit as three sequential ticks. Critical parameters get a `status.critical` stitch colour on the sheet itself.

### 4.9 Activity / Passive Change Indicator
*Cream timeline.* Reverse-chronological write history: parameter, old → new, actor, and a **source badge** — `Local` / `Admin remote` / `Admin Force Push` (PRD §7.5, §9.3). Admin-sourced entries carry an `accent` left rail. On the Dashboard this surfaces as `PassiveChangeBanner`: appears, never blocks, needs no dismissal, auto-collapses after 10 s but stays in the timeline. Critical-level admin changes get a `status.critical` rail — the "stronger visual flag" the PRD's open questions recommend.

### 4.10 Support Session
*Leather header with a live `accent` pulse dot → cream body.* Shows session ID, admin name, start time, running action list. Ends with a plain-language statement of the Mode 1 guarantee: *"An administrator can only reach this battery while your Bluetooth session is active."* Read-only; there is no approve/deny control by design (PRD §6.3 step 7).

### 4.11 Device
*Cream, list-only.* Device ID `KYE-000184`, hardware rev, firmware, last seen, and a **Security Status** row that is `status.good` only when device authentication passed — `status.critical` otherwise, with connection blocked (Build Plan Phase 4: the app refuses unverified peripherals).

### 4.12 History
*Thin leather header → cream body.* Segmented control `SOC · Voltage · Current · Temp`, range chips `1H / 24H / 7D`. One stitched chart card: sparkline in `accent`, three horizontal `panel.track` gridlines, and — the important part — a **scrubber that prints the exact value and timestamp** at the touch point. Charts obey the same rule as gauges: no value without a number.

### 4.13 Help
*Cream, accordion.* Safety-first ordering: what a critical parameter change can do → BLE troubleshooting → what the audit log records → support contact.

---

## 5. Applying the language to a screen that isn't in this plan

Four questions, in order:

1. **Is anything on this screen live and primary?** Yes → leather hero at top. No → thin 96pt leather header only.
2. **Is the data a set of facts?** Then it is `DataRow`s in a stitched cream panel. Not a gauge. Never a gauge.
3. **Does the screen end?** Close it with a `FactStrip` or a `SectionLabel`ed group — never a naked scroll end.
4. **Is any value on it `danger_level: Critical`?** Then it must appear as text at ≥14pt with a `DangerDot`, regardless of what else represents it.

Anti-patterns, stated so they get caught in review: gauges on list screens; more than one hero gauge; card borders instead of stitching; a third font; Material shadows; needle-only critical values; a leather panel that scrolls (leather is always pinned, cream always scrolls).

---

## 6. Build order

Matching Build Plan Phase 1's explicit instruction — *"build the leather-stitch material theme as a shared base applied across all screens, **before** building individual gauge/instrument components on top of it."*

1. Theme + tokens + `LeatherPanel` + typography — proven on a throwaway screen with both themes.
2. Polar maths module + unit tests (`angleFor(50, 0, 100) === 0`, bipolar zero at 12 o'clock).
3. `Gauge` all three variants, static values, storybook-style screen.
4. Telemetry provider + `MockSource` @ 2 Hz → Dashboard live. **This is the "real time" milestone.**
5. Cells / Protection / BMS Info / Device / History off the same store.
6. Settings from capability profile → Write Confirmation → Activity.
7. Login / Battery List / Support Session / Help.
8. Swap `MockSource` → `BleSource`. No screen changes if steps 1–7 were done right.

---

## 7. Acceptance criteria

- [ ] Dashboard is visually indistinguishable from the reference mock in composition, at 375 × 812 and 430 × 932.
- [ ] Both themes ship; every text pair ≥ 4.5:1.
- [ ] Every gauge renders a numeric readout with no prop able to suppress it.
- [ ] Needle spring settles ≤ 700 ms; digits never lag truth by > 250 ms.
- [ ] Telemetry updates at 2 Hz with no dropped frames on a 2019-era device.
- [ ] Settings renders entirely from a capability profile JSON — deleting a parameter from the JSON removes its row with no code change.
- [ ] Write Confirmation cannot be completed with an empty reason when `danger_level: Critical`.
- [ ] Location card is present and shows the §7.16 placeholder.
- [ ] Reduce Motion disables needle springs and digit rolls.
- [ ] Swapping `MockSource` for `BleSource` touches no screen file.
