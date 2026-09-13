/**
 * The mutual handshake, docs/BLE_CONTRACT.md §5, as a pure state machine.
 *
 * The transport hands it bytes from the Auth characteristic and sends what it
 * returns; it never sees the radio. That is what lets the whole exchange be
 * tested against a gateway written in the same file, and lets the firmware be
 * checked against these exact vectors.
 */
import { bytesEqual, concat, hmacSha256, utf8 } from './sha256';

export const NONCE_LENGTH = 16;

const LABEL_GATEWAY = utf8('MEB-GW-1');
const LABEL_APP = utf8('MEB-APP-1');
const LABEL_SESSION = utf8('MEB-SESS-1');

export const gatewayTag = (key: Uint8Array, serial: string, nonceA: Uint8Array, nonceG: Uint8Array) =>
  hmacSha256(key, concat(LABEL_GATEWAY, utf8(serial), nonceA, nonceG));

export const appTag = (key: Uint8Array, serial: string, nonceG: Uint8Array, nonceA: Uint8Array) =>
  hmacSha256(key, concat(LABEL_APP, utf8(serial), nonceG, nonceA));

export const sessionKey = (key: Uint8Array, nonceA: Uint8Array, nonceG: Uint8Array) =>
  hmacSha256(key, concat(LABEL_SESSION, nonceA, nonceG));

export type AuthStatus = 'ok' | 'bad_tag' | 'out_of_order' | 'not_provisioned' | 'unknown';

const STATUS_BY_CODE: Record<number, AuthStatus> = {
  0x00: 'ok',
  0x01: 'bad_tag',
  0x02: 'out_of_order',
  0x03: 'not_provisioned',
};

export class GatewayUnverifiedError extends Error {
  constructor(readonly serial: string, detail: string) {
    super(`Gateway ${serial} could not be verified: ${detail}`);
    this.name = 'GatewayUnverifiedError';
  }
}

export class AuthRefusedError extends Error {
  constructor(readonly serial: string, readonly status: AuthStatus) {
    super(`Gateway ${serial} refused the app: ${status}`);
    this.name = 'AuthRefusedError';
  }
}

/**
 * The app's side. Drive it: `start()` gives the first write; feed each Auth
 * notification to `receive()`, which returns the next write (or null when
 * the handshake is complete); read `sessionKey` afterwards.
 */
export class AppHandshake {
  private nonceA: Uint8Array;
  private nonceG: Uint8Array | null = null;
  private done = false;
  private key: Uint8Array | null = null;

  constructor(
    private readonly gatewayKey: Uint8Array,
    private readonly serial: string,
    random: (n: number) => Uint8Array
  ) {
    this.nonceA = random(NONCE_LENGTH);
    if (this.nonceA.length !== NONCE_LENGTH) throw new Error('Nonce must be 16 bytes');
  }

  start(): Uint8Array {
    return concat(new Uint8Array([0x01]), this.nonceA);
  }

  receive(notification: Uint8Array): Uint8Array | null {
    const kind = notification[0];
    if (kind === 0x02) {
      if (notification.length !== 1 + NONCE_LENGTH + 32) {
        throw new GatewayUnverifiedError(this.serial, 'malformed challenge response');
      }
      const nonceG = notification.subarray(1, 1 + NONCE_LENGTH);
      const tagG = notification.subarray(1 + NONCE_LENGTH);
      // The proof that the peripheral holds the key. Wrong and we walk away
      // without sending anything that depends on it.
      if (!bytesEqual(tagG, gatewayTag(this.gatewayKey, this.serial, this.nonceA, nonceG))) {
        throw new GatewayUnverifiedError(this.serial, 'wrong key');
      }
      this.nonceG = new Uint8Array(nonceG);
      return concat(new Uint8Array([0x03]), appTag(this.gatewayKey, this.serial, this.nonceG, this.nonceA));
    }
    if (kind === 0x04) {
      const status = STATUS_BY_CODE[notification[1] ?? 0xff] ?? 'unknown';
      if (status !== 'ok' || !this.nonceG) throw new AuthRefusedError(this.serial, status);
      this.key = sessionKey(this.gatewayKey, this.nonceA, this.nonceG);
      this.done = true;
      return null;
    }
    throw new GatewayUnverifiedError(this.serial, `unexpected auth message 0x${(kind ?? 0).toString(16)}`);
  }

  get complete(): boolean {
    return this.done;
  }

  /** Only after `complete`. */
  get session(): Uint8Array {
    if (!this.key) throw new Error('Handshake not complete');
    return this.key;
  }
}

/**
 * The gateway's side, in TypeScript, so the app's handshake can be tested
 * against a peer written from the same document — and so the firmware's
 * vectors can be generated here.
 */
export class GatewayHandshake {
  private nonceA: Uint8Array | null = null;
  private nonceG: Uint8Array | null = null;
  session: Uint8Array | null = null;

  constructor(
    private readonly key: Uint8Array | null,
    private readonly serial: string,
    private readonly random: (n: number) => Uint8Array
  ) {}

  receive(write: Uint8Array): Uint8Array {
    const kind = write[0];
    if (!this.key) return new Uint8Array([0x04, 0x03]);
    if (kind === 0x01) {
      if (write.length !== 1 + NONCE_LENGTH) return new Uint8Array([0x04, 0x02]);
      this.nonceA = new Uint8Array(write.subarray(1));
      this.nonceG = this.random(NONCE_LENGTH);
      return concat(
        new Uint8Array([0x02]),
        this.nonceG,
        gatewayTag(this.key, this.serial, this.nonceA, this.nonceG)
      );
    }
    if (kind === 0x03) {
      if (!this.nonceA || !this.nonceG) return new Uint8Array([0x04, 0x02]);
      const expected = appTag(this.key, this.serial, this.nonceG, this.nonceA);
      if (write.length !== 33 || !bytesEqual(write.subarray(1), expected)) {
        this.nonceA = null;
        this.nonceG = null;
        return new Uint8Array([0x04, 0x01]);
      }
      this.session = sessionKey(this.key, this.nonceA, this.nonceG);
      return new Uint8Array([0x04, 0x00]);
    }
    return new Uint8Array([0x04, 0x02]);
  }
}

/** §7.1: the first 16 bytes of HMAC(S, body). */
export const commandTag = (session: Uint8Array, body: Uint8Array): Uint8Array =>
  hmacSha256(session, body).subarray(0, 16);
