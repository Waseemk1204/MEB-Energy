/**
 * Simulated 24S LiFePO4 pack on a JBD SP24S004 (200 A SKU, 100 Ah).
 *
 * This is a small physics model rather than random noise, and that distinction
 * matters: a coulomb counter integrates pack current against capacity, and cell
 * voltages ride a LiFePO4 OCV curve with an IR drop proportional to current. So
 * SOC, pack voltage and pack current move together the way real hardware does.
 * Random walks on three independent needles look immediately fake.
 */
import {
  TELEMETRY_INTERVAL_MS,
  type BatterySnapshot,
  type Fault,
  type TelemetrySource,
  type WriteResult,
} from './types';

const CELL_COUNT = 24;
const CAPACITY_AH = 100;
const CELL_IR_OHM = 0.0004; // 0.4 mΩ per cell
const BALANCE_START_V = 3.4;
const CELL_OVP_V = 3.75;

/** LiFePO4 open-circuit voltage curve, SOC % → resting cell volts. */
const OCV_CURVE: [number, number][] = [
  [0, 3.0],
  [5, 3.18],
  [15, 3.245],
  [30, 3.28],
  [50, 3.3],
  [70, 3.315],
  [85, 3.335],
  [95, 3.4],
  [100, 3.52],
];

function ocv(soc: number): number {
  for (let i = 1; i < OCV_CURVE.length; i++) {
    const [x1, y1] = OCV_CURVE[i];
    if (soc <= x1) {
      const [x0, y0] = OCV_CURVE[i - 1];
      const t = (soc - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return OCV_CURVE[OCV_CURVE.length - 1][1];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

type Phase = { name: 'charge' | 'idle' | 'discharge'; current: number; seconds: number };

const PHASES: Phase[] = [
  { name: 'charge', current: 168, seconds: 34 },
  { name: 'idle', current: 0, seconds: 9 },
  { name: 'discharge', current: -142, seconds: 30 },
  { name: 'idle', current: 0, seconds: 8 },
];

export class MockSource implements TelemetrySource {
  /** Invented. Nothing this produces may be uploaded as a measurement. */
  readonly simulated = true;

  private timer: ReturnType<typeof setInterval> | null = null;
  private seed: number;
  private soc = 72;
  private current = 168;
  private temp = 24;
  private spread = 0.012;
  private phase = 0;
  private phaseElapsed = 0;
  private offsets: number[] = [];
  /** Settings the safe-write flow has changed, so read-back returns the new value. */
  private settings = new Map<string, number>();

  constructor(seed = 20260903) {
    this.seed = seed;
    for (let i = 0; i < CELL_COUNT; i++) this.offsets.push((this.rnd() - 0.5) * 2);
    // Warm the model up so the first frame is mid-cycle, not a cold start.
    for (let i = 0; i < 40; i++) this.step(TELEMETRY_INTERVAL_MS / 1000);
  }

  /** Seeded LCG — runs are reproducible, which makes UI bugs reproducible too. */
  private rnd(): number {
    this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
    return this.seed / 4294967296;
  }

  private step(dt: number): void {
    this.phaseElapsed += dt;
    let phase = PHASES[this.phase];
    if (this.phaseElapsed > phase.seconds) {
      this.phase = (this.phase + 1) % PHASES.length;
      this.phaseElapsed = 0;
      phase = PHASES[this.phase];
    }

    let target = phase.current;
    // Charge current tapers as the pack fills, as a real CC/CV charger does.
    if (phase.name === 'charge') {
      target *= Math.max(0.18, 1 - Math.pow(this.soc / 100, 6));
    }

    this.current += (target - this.current) * 0.18 + (this.rnd() - 0.5) * 7;
    if (Math.abs(target) < 1 && Math.abs(this.current) < 2) this.current *= 0.5;

    // Coulomb counting: Ah moved / capacity.
    this.soc = clamp(this.soc + ((this.current * dt) / 3600 / CAPACITY_AH) * 100, 4, 100);

    const ambient = 22 + Math.abs(this.current) * 0.055;
    this.temp = clamp(this.temp + (ambient - this.temp) * 0.05, 18, 44);

    const restingV = ocv(this.soc);
    const balancing = restingV > BALANCE_START_V && this.current > 2;
    // Spread widens on its own and narrows while balancing works.
    this.spread += balancing ? (0.006 - this.spread) * 0.05 : (0.02 - this.spread) * 0.012;
  }

  private snapshot(): BatterySnapshot {
    const restingV = ocv(this.soc);
    const irDrop = this.current * CELL_IR_OHM;
    const cellVoltages = this.offsets.map((o) => restingV + irDrop + o * this.spread);

    const minCellV = Math.min(...cellVoltages);
    const maxCellV = Math.max(...cellVoltages);
    const balancing = restingV > BALANCE_START_V && this.current > 2;

    const faults: Fault[] = [];
    if (maxCellV > CELL_OVP_V) {
      faults.push({
        code: 'CELL_OVP',
        label: 'Cell over-voltage',
        level: 'Critical',
        detail: `Cell ${cellVoltages.indexOf(maxCellV) + 1} · ${maxCellV.toFixed(3)} V vs 3.750 V limit`,
      });
    }
    if (this.temp > 40) {
      faults.push({
        code: 'PACK_HTP',
        label: 'Pack temperature high',
        level: 'Warning',
        detail: `${this.temp.toFixed(0)} °C approaching the 65 °C charge limit`,
      });
    }

    return {
      timestamp: Date.now(),
      soc: this.soc,
      packVoltage: cellVoltages.reduce((a, b) => a + b, 0),
      packCurrent: this.current,
      temperatures: [this.temp, this.temp - 1.4],
      cellVoltages,
      cellCount: CELL_COUNT,
      minCellV,
      maxCellV,
      deltaMv: (maxCellV - minCellV) * 1000,
      chargeMos: true,
      dischargeMos: true,
      balancing,
      balancingCells: balancing
        ? cellVoltages.map((v, i) => (v > BALANCE_START_V ? i : -1)).filter((i) => i >= 0)
        : [],
      faults,
      cycles: 142,
      soh: 96,
      bmsModel: 'JBD SP24S004',
      bmsFirmware: 'FW 1.2.4',
      bleState: 'connected',
      location: null,
    };
  }

  start(onSnapshot: (s: BatterySnapshot) => void): void {
    this.stop();
    onSnapshot(this.snapshot());
    this.timer = setInterval(() => {
      this.step(TELEMETRY_INTERVAL_MS / 1000);
      onSnapshot(this.snapshot());
    }, TELEMETRY_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async readSetting(key: string): Promise<number> {
    await new Promise((r) => setTimeout(r, 180));
    return this.settings.get(key) ?? 0;
  }

  async writeSetting(key: string, value: number): Promise<WriteResult> {
    await new Promise((r) => setTimeout(r, 620));
    this.settings.set(key, value);
    return { ok: true, readBack: value };
  }
}
