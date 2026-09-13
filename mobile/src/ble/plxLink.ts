/**
 * react-native-ble-plx: the phone's radio, behind GattLink.
 *
 * Loaded lazily, because the module carries a native binding that does not
 * exist in a browser or in Jest; nothing imports this file on those
 * platforms except through `nativeFinder()`, which is only called on a
 * phone. Values cross the bridge as base64.
 */
import { Platform } from 'react-native';
import { BleUnavailableError, type GattFinder, type GattLink } from './link';

type Manager = import('react-native-ble-plx').BleManager;
type Device = import('react-native-ble-plx').Device;

let manager: Manager | null = null;

function bleManager(): Manager {
  if (Platform.OS === 'web') throw new BleUnavailableError('Native Bluetooth is not available in a browser');
  if (!manager) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BleManager } = require('react-native-ble-plx') as typeof import('react-native-ble-plx');
    manager = new BleManager();
  }
  return manager;
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return globalThis.btoa(binary);
};

const fromBase64 = (s: string): Uint8Array => {
  const binary = globalThis.atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

export class PlxGattLink implements GattLink {
  readonly id: string;
  readonly name: string | null;
  private device: Device | null = null;
  private negotiatedMtu = 23;
  private disconnectHandlers: (() => void)[] = [];
  private disconnectSubscription: { remove: () => void } | null = null;

  constructor(
    private readonly found: Device,
    private readonly serviceUuid: string
  ) {
    this.id = found.id;
    this.name = found.name ?? found.localName ?? null;
  }

  async connect(): Promise<void> {
    const m = bleManager();
    let device = await m.connectToDevice(this.found.id, { timeout: 10_000 });
    this.disconnectSubscription = m.onDeviceDisconnected(this.found.id, () => {
      this.device = null;
      this.disconnectHandlers.splice(0).forEach((h) => h());
    });
    // Android negotiates on request; iOS negotiates on its own and reports.
    try {
      device = await device.requestMTU(247);
    } catch {
      // Not supported here; the gateway fragments to whatever was agreed.
    }
    this.negotiatedMtu = device.mtu || 23;
    device = await device.discoverAllServicesAndCharacteristics();
    this.device = device;
  }

  async disconnect(): Promise<void> {
    this.disconnectSubscription?.remove();
    this.disconnectSubscription = null;
    const d = this.device;
    this.device = null;
    if (d) await bleManager().cancelDeviceConnection(d.id).catch(() => undefined);
    this.disconnectHandlers.splice(0).forEach((h) => h());
  }

  mtu(): number {
    return this.negotiatedMtu;
  }

  private connected(): Device {
    if (!this.device) throw new BleUnavailableError('Not connected');
    return this.device;
  }

  async read(uuid: string): Promise<Uint8Array> {
    const c = await this.connected().readCharacteristicForService(this.serviceUuid, uuid);
    return c.value ? fromBase64(c.value) : new Uint8Array(0);
  }

  async write(uuid: string, bytes: Uint8Array): Promise<void> {
    await this.connected().writeCharacteristicWithResponseForService(this.serviceUuid, uuid, toBase64(bytes));
  }

  async subscribe(uuid: string, onValue: (bytes: Uint8Array) => void): Promise<() => void> {
    const sub = this.connected().monitorCharacteristicForService(this.serviceUuid, uuid, (error, c) => {
      if (error || !c?.value) return;
      onValue(fromBase64(c.value));
    });
    return () => sub.remove();
  }

  onDisconnected(handler: () => void): () => void {
    this.disconnectHandlers.push(handler);
    return () => {
      this.disconnectHandlers = this.disconnectHandlers.filter((h) => h !== handler);
    };
  }
}

/** Scans silently and takes the first gateway `accept` says yes to. */
export const nativeFinder: GattFinder = {
  choose({ service, namePrefix, timeoutMs, accept }) {
    const m = bleManager();
    return new Promise<GattLink>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        m.stopDeviceScan();
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new BleUnavailableError('No gateway found nearby. Is it powered, and within a few metres?'))),
        timeoutMs
      );
      m.startDeviceScan([service], { allowDuplicates: false }, (error, device) => {
        if (error) return finish(() => reject(new BleUnavailableError(error.message)));
        if (!device) return;
        const name = device.name ?? device.localName ?? null;
        if (name && !name.startsWith(namePrefix)) return;
        if (!accept({ id: device.id, name })) return;
        finish(() => resolve(new PlxGattLink(device, service)));
      });
    });
  },
};
