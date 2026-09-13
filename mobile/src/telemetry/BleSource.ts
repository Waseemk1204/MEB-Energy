/**
 * BLE transport to the gateway.
 *
 * Deliberately the same interface as MockSource: swapping the source must not
 * touch a single screen file. The gateway hands us already-normalized frames —
 * the JBD adapter lives in firmware, so nothing here parses vendor packets.
 *
 * Security posture: the GatewayClient this wraps has already read the
 * gateway's identity, checked it against the company's list, and completed
 * the mutual handshake. A client that did not pass all three never reaches
 * here — see ble/linkGateway.ts, which is the only thing that constructs one.
 */
import type { BatterySnapshot, TelemetrySource, WriteResult } from './types';
import { WriteTimeoutError } from './writeOutcome';
import { BmsTimeoutError, CommandRefusedError, type GatewayClient } from '../ble/gateway';

export class BleSource implements TelemetrySource {
  /** Read off a real BMS over a real link. */
  readonly simulated = false;

  constructor(private readonly gateway: GatewayClient) {}

  start(onSnapshot: (s: BatterySnapshot) => void): void {
    void this.gateway.subscribeTelemetry(onSnapshot);
  }

  stop(): void {
    void this.gateway.close();
  }

  async readSetting(key: string): Promise<number> {
    return this.gateway.readParam(key);
  }

  /**
   * What the BMS holds afterwards is what is reported, never what was sent.
   * A silent BMS is a timeout — the write may have landed — and the
   * classifier says so; a refusal is a refusal, with the gateway's reason.
   */
  async writeSetting(key: string, value: number): Promise<WriteResult> {
    try {
      const { readBack } = await this.gateway.writeParam(key, value);
      return { ok: true, readBack };
    } catch (error) {
      if (error instanceof BmsTimeoutError) throw new WriteTimeoutError();
      if (error instanceof CommandRefusedError) return { ok: false, error: `Refused: ${error.message}.` };
      throw error;
    }
  }
}
