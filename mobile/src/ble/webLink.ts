/**
 * Web Bluetooth: the browser's radio, behind GattLink.
 *
 * Chrome and Edge on Android, Windows, macOS, Linux and ChromeOS have it.
 * Safari on iOS does not, and never has; there the on-site path is the
 * phone build. `available()` says which situation the app is in so the
 * connect flow can explain rather than fail.
 *
 * The browser draws its own chooser, so "scan" here means asking the user
 * to pick from what the browser shows -- filtered to gateways by the
 * service UUID and the MEB- prefix. That requires a user gesture, which the
 * tap on a battery row supplies.
 */
import { BleUnavailableError, type GattFinder, type GattLink } from './link';

interface WebCharacteristic {
  readValue(): Promise<DataView>;
  writeValueWithResponse?(v: BufferSource): Promise<void>;
  writeValue(v: BufferSource): Promise<void>;
  startNotifications(): Promise<unknown>;
  stopNotifications(): Promise<unknown>;
  addEventListener(type: 'characteristicvaluechanged', handler: (e: Event) => void): void;
  removeEventListener(type: 'characteristicvaluechanged', handler: (e: Event) => void): void;
  value: DataView | null;
}

interface WebService {
  getCharacteristic(uuid: string): Promise<WebCharacteristic>;
}

interface WebGatt {
  connected: boolean;
  connect(): Promise<WebGatt>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<WebService>;
}

interface WebDevice {
  id: string;
  name?: string;
  gatt?: WebGatt;
  addEventListener(type: 'gattserverdisconnected', handler: () => void): void;
  removeEventListener(type: 'gattserverdisconnected', handler: () => void): void;
}

interface WebBluetooth {
  requestDevice(options: {
    filters: { services?: string[]; namePrefix?: string }[];
    optionalServices?: string[];
  }): Promise<WebDevice>;
  getAvailability?(): Promise<boolean>;
}

const bluetooth = (): WebBluetooth | null =>
  ((globalThis as { navigator?: { bluetooth?: WebBluetooth } }).navigator?.bluetooth as WebBluetooth | undefined) ??
  null;

export async function available(): Promise<{ ok: boolean; reason: string | null }> {
  const b = bluetooth();
  if (!b) {
    const ua = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? '';
    if (/iPhone|iPad|iPod/.test(ua)) {
      return { ok: false, reason: 'Safari on iOS has no Bluetooth for web apps. On iPhone, use the MEB Energy app from the App Store build.' };
    }
    return { ok: false, reason: 'This browser has no Web Bluetooth. Chrome or Edge on Android, Windows, macOS or Linux does.' };
  }
  if (b.getAvailability && !(await b.getAvailability())) {
    return { ok: false, reason: 'Bluetooth is off or this device has no radio.' };
  }
  return { ok: true, reason: null };
}

export class WebGattLink implements GattLink {
  readonly id: string;
  readonly name: string | null;
  private service: WebService | null = null;
  private characteristics = new Map<string, WebCharacteristic>();
  private disconnectHandlers: (() => void)[] = [];
  private onGattDisconnected = () => {
    this.service = null;
    this.characteristics.clear();
    this.disconnectHandlers.splice(0).forEach((h) => h());
  };

  constructor(
    private readonly device: WebDevice,
    private readonly serviceUuid: string
  ) {
    this.id = device.id;
    this.name = device.name ?? null;
  }

  async connect(): Promise<void> {
    if (!this.device.gatt) throw new BleUnavailableError('The browser gave no GATT server for this device');
    this.device.addEventListener('gattserverdisconnected', this.onGattDisconnected);
    const gatt = await this.device.gatt.connect();
    this.service = await gatt.getPrimaryService(this.serviceUuid);
  }

  async disconnect(): Promise<void> {
    this.device.removeEventListener('gattserverdisconnected', this.onGattDisconnected);
    if (this.device.gatt?.connected) this.device.gatt.disconnect();
    this.onGattDisconnected();
  }

  /** Web Bluetooth hides the MTU; the gateway fragments to what was agreed anyway. */
  mtu(): number {
    return 23;
  }

  private async characteristic(uuid: string): Promise<WebCharacteristic> {
    if (!this.service) throw new BleUnavailableError('Not connected');
    let c = this.characteristics.get(uuid);
    if (!c) {
      c = await this.service.getCharacteristic(uuid);
      this.characteristics.set(uuid, c);
    }
    return c;
  }

  async read(uuid: string): Promise<Uint8Array> {
    const c = await this.characteristic(uuid);
    const v = await c.readValue();
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }

  async write(uuid: string, bytes: Uint8Array): Promise<void> {
    const c = await this.characteristic(uuid);
    // A copy into a plain ArrayBuffer: the API refuses a view over shared memory.
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    if (c.writeValueWithResponse) await c.writeValueWithResponse(copy.buffer);
    else await c.writeValue(copy.buffer);
  }

  async subscribe(uuid: string, onValue: (bytes: Uint8Array) => void): Promise<() => void> {
    const c = await this.characteristic(uuid);
    const handler = () => {
      const v = c.value;
      if (v) onValue(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
    };
    c.addEventListener('characteristicvaluechanged', handler);
    await c.startNotifications();
    return () => {
      c.removeEventListener('characteristicvaluechanged', handler);
      c.stopNotifications().catch(() => undefined);
    };
  }

  onDisconnected(handler: () => void): () => void {
    this.disconnectHandlers.push(handler);
    return () => {
      this.disconnectHandlers = this.disconnectHandlers.filter((h) => h !== handler);
    };
  }
}

export const webFinder: GattFinder = {
  async choose({ service, namePrefix, accept }) {
    const b = bluetooth();
    if (!b) throw new BleUnavailableError((await available()).reason ?? 'No Web Bluetooth');
    let device: WebDevice;
    try {
      // The browser shows its chooser filtered to gateways; the user picks.
      device = await b.requestDevice({
        filters: [{ services: [service] }, { namePrefix }],
        optionalServices: [service],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BleUnavailableError(/cancel/i.test(message) ? 'No gateway was chosen.' : message);
    }
    if (!accept({ id: device.id, name: device.name ?? null })) {
      throw new BleUnavailableError(`${device.name ?? 'That device'} is not one of this company's gateways.`);
    }
    return new WebGattLink(device, service);
  },
};
