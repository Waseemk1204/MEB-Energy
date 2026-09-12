/**
 * BLE transport to the ESP32 gateway.
 *
 * Deliberately the same interface as MockSource: swapping USE_MOCK must not
 * touch a single screen file. The gateway hands us already-normalized frames —
 * the JBD adapter lives in firmware, so nothing here parses vendor packets.
 *
 * Security posture (Build Plan Phase 4): this client refuses to read from or
 * relay commands to any peripheral that fails device authentication. An
 * unverified peripheral is never treated as a company gateway.
 */
import type { BatterySnapshot, TelemetrySource, WriteResult } from './types';

/** Placeholder service/characteristic identifiers — align with the firmware track. */
export const KYE_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const KYE_TELEMETRY_CHAR = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
export const KYE_COMMAND_CHAR = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';

export class DeviceAuthenticationError extends Error {
  constructor(deviceId: string) {
    super(`Peripheral ${deviceId} failed gateway authentication`);
    this.name = 'DeviceAuthenticationError';
  }
}

export class BleSource implements TelemetrySource {
  /** Read off a real BMS over a real link. */
  readonly simulated = false;

  private onSnapshot: ((s: BatterySnapshot) => void) | null = null;
  private subscription: { remove: () => void } | null = null;

  constructor(private readonly deviceId: string) {}

  start(onSnapshot: (s: BatterySnapshot) => void): void {
    this.onSnapshot = onSnapshot;
    // Wiring order, once the firmware contract is stable:
    //   1. BleManager.connectToDevice(this.deviceId)
    //   2. authenticate — challenge/response against the device's secure element.
    //      On failure: throw DeviceAuthenticationError and do NOT subscribe.
    //   3. discoverAllServicesAndCharacteristics()
    //   4. monitorCharacteristicForService(KYE_SERVICE_UUID, KYE_TELEMETRY_CHAR, cb)
    //   5. decode each frame into BatterySnapshot and call this.emit()
    throw new Error(
      'BleSource is not wired yet — the firmware telemetry contract is still in ' +
        'definition. Run with USE_MOCK = true until the gateway ships.'
    );
  }

  protected emit(snapshot: BatterySnapshot): void {
    this.onSnapshot?.(snapshot);
  }

  stop(): void {
    this.subscription?.remove();
    this.subscription = null;
    this.onSnapshot = null;
  }

  async readSetting(_key: string): Promise<number> {
    throw new Error('BleSource.readSetting is not wired yet');
  }

  async writeSetting(_key: string, _value: number): Promise<WriteResult> {
    throw new Error('BleSource.writeSetting is not wired yet');
  }
}
