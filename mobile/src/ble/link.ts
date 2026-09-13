/**
 * The radio, as the gateway client sees it.
 *
 * Two implementations: Web Bluetooth in the browser (webLink.ts) and
 * react-native-ble-plx on a phone (plxLink.ts). Everything above this line --
 * the handshake, the codec, the client -- is written once against this
 * interface and tested against a fake of it.
 */

export interface GattLink {
  /** The platform's own id for the peripheral; opaque. */
  readonly id: string;
  /** The advertised name, e.g. MEB-000184, if known. */
  readonly name: string | null;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** The negotiated MTU, or 23 if the platform will not say. */
  mtu(): number;

  read(characteristic: string): Promise<Uint8Array>;
  write(characteristic: string, bytes: Uint8Array): Promise<void>;
  /** Resolves once notifications are on; the returned function turns them off. */
  subscribe(characteristic: string, onValue: (bytes: Uint8Array) => void): Promise<() => void>;
  /** Fires once when the link goes, for whatever reason. */
  onDisconnected(handler: () => void): () => void;
}

/**
 * Finds gateways. The browser can only ask the user to pick one from a
 * chooser it draws itself; a phone can scan silently. `choose` covers both:
 * it resolves with a link to one peripheral advertising the gateway service
 * that passes `accept`, or rejects when none does before `timeoutMs`.
 */
export interface GattFinder {
  choose(options: {
    service: string;
    namePrefix: string;
    timeoutMs: number;
    /** Called with each candidate as it appears; return false to keep looking. */
    accept: (candidate: { id: string; name: string | null }) => boolean;
  }): Promise<GattLink>;
}

export class BleUnavailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'BleUnavailableError';
  }
}

export class LinkLostError extends Error {
  constructor(message = 'The connection to the gateway was lost') {
    super(message);
    this.name = 'LinkLostError';
  }
}
