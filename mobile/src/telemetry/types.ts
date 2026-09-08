/**
 * Normalized telemetry. The app and cloud operate only on this shape — never on
 * vendor packet formats. Adding a BMS vendor means adding a TelemetrySource,
 * not touching a screen.
 */

export type BleState = 'connected' | 'connecting' | 'disconnected';

export type FaultLevel = 'Warning' | 'Critical';

export interface Fault {
  code: string;
  label: string;
  level: FaultLevel;
  detail?: string;
}

export interface BatterySnapshot {
  timestamp: number;
  /** % */
  soc: number;
  /** V */
  packVoltage: number;
  /** A — positive is charging, negative is discharging. */
  packCurrent: number;
  /** °C, one per NTC probe (SP24S004 exposes two: J3, J4). */
  temperatures: number[];
  /** V, length === cellCount */
  cellVoltages: number[];
  cellCount: number;
  minCellV: number;
  maxCellV: number;
  deltaMv: number;
  chargeMos: boolean;
  dischargeMos: boolean;
  balancing: boolean;
  balancingCells: number[];
  faults: Fault[];
  cycles: number;
  /** % state of health */
  soh: number;
  bmsModel: string;
  bmsFirmware: string;
  bleState: BleState;
  /** Reserved for GPS-capable hardware. Always null until then. */
  location: null;
}

export interface WriteResult {
  ok: boolean;
  readBack?: number;
  error?: string;
}

export interface TelemetrySource {
  /**
   * Whether these readings came from hardware.
   *
   * Declared by the source rather than inferred from a build flag, because the
   * readings go to a server and are then shown to people as measurements from
   * a physical pack. Fabricated numbers in a fleet list read exactly like real
   * ones — there is nothing about `72.81 %` that says it was invented — so the
   * only place that can be honest about it is the thing that produced it.
   */
  readonly simulated: boolean;

  start(onSnapshot: (s: BatterySnapshot) => void): void;
  stop(): void;
  readSetting(key: string): Promise<number>;
  writeSetting(key: string, value: number): Promise<WriteResult>;
}

export const TELEMETRY_INTERVAL_MS = 500; // 2 Hz
