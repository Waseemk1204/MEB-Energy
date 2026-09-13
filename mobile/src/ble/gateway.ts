/**
 * A connected gateway, as the app uses one.
 *
 * Owns the link, runs the handshake, reassembles fragments, matches each
 * response to the command that asked for it, and turns telemetry frames
 * into the app's BatterySnapshot. The transport is a GattLink, so the same
 * class runs in a browser, on a phone, and against a fake in the tests.
 *
 * Order matters and is enforced here: identity, then handshake, then
 * anything else. A gateway the app cannot verify is disconnected before a
 * single telemetry frame is read.
 */
import { AppHandshake, commandTag } from './auth';
import {
  CHAR_AUTH,
  CHAR_COMMAND,
  CHAR_IDENTITY,
  CHAR_RESPONSE,
  CHAR_TELEMETRY,
  FrameError,
  OP,
  PROTOCOL_VERSION,
  Reassembler,
  STATUS,
  STATUS_LABEL,
  decodeIdentity,
  decodeProtection,
  decodeResponse,
  decodeTelemetry,
  encodeCommand,
  fromWire,
  paramByKey,
  readI32,
  readParamPayload,
  toWire,
  writeParamPayload,
  commandBody,
  type Identity,
  type TelemetryFrame,
} from './codec';
import { LinkLostError, type GattLink } from './link';
import type { BatterySnapshot } from '../telemetry/types';

export const HANDSHAKE_TIMEOUT_MS = 8000;
export const COMMAND_TIMEOUT_MS = 6000;

export class GatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayError';
  }
}

/** The gateway answered, and the answer was no. */
export class CommandRefusedError extends GatewayError {
  constructor(readonly status: number) {
    super(STATUS_LABEL[status] ?? `the gateway answered with status ${status}`);
    this.name = 'CommandRefusedError';
  }
}

/** The BMS did not answer the gateway in time. Distinct: the write may have landed. */
export class BmsTimeoutError extends GatewayError {
  constructor() {
    super('The BMS did not answer the gateway');
    this.name = 'BmsTimeoutError';
  }
}

export interface GatewayClientOptions {
  random: (n: number) => Uint8Array;
  now?: () => number;
}

export class GatewayClient {
  identity: Identity | null = null;
  private session: Uint8Array | null = null;
  private seq = 1;
  private responses = new Reassembler();
  private telemetry = new Reassembler();
  private pending = new Map<number, { resolve: (r: { status: number; payload: Uint8Array }) => void; reject: (e: Error) => void }>();
  private unsubscribeResponse: (() => void) | null = null;
  private unsubscribeTelemetry: (() => void) | null = null;
  private removeDisconnect: (() => void) | null = null;
  private closed = false;

  constructor(
    readonly link: GattLink,
    private readonly options: GatewayClientOptions
  ) {}

  /** Step 1: connect and read who this is. Nothing is trusted yet. */
  async open(): Promise<Identity> {
    await this.link.connect();
    this.removeDisconnect = this.link.onDisconnected(() => this.onLost());
    const raw = await this.link.read(CHAR_IDENTITY);
    const identity = decodeIdentity(raw);
    if (identity.protocolVersion !== PROTOCOL_VERSION) {
      await this.close();
      throw new GatewayError(
        `This gateway speaks protocol ${identity.protocolVersion}; this app speaks ${PROTOCOL_VERSION}. One of them needs updating.`
      );
    }
    this.identity = identity;
    return identity;
  }

  /**
   * Step 2: prove the gateway holds the key, and prove to it that we do.
   * Rejects, and disconnects, if either half fails.
   */
  async authenticate(key: Uint8Array): Promise<void> {
    const serial = this.identity?.serial;
    if (!serial) throw new GatewayError('The gateway has no serial; it is not provisioned');

    const handshake = new AppHandshake(key, serial, this.options.random);
    const replies: Uint8Array[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = await this.link.subscribe(CHAR_AUTH, (bytes) => {
      replies.push(bytes);
      wake?.();
    });

    const next = () =>
      new Promise<Uint8Array>((resolve, reject) => {
        const timer = setTimeout(() => reject(new GatewayError('The gateway did not answer the handshake')), HANDSHAKE_TIMEOUT_MS);
        const take = () => {
          const r = replies.shift();
          if (!r) return;
          clearTimeout(timer);
          wake = null;
          resolve(r);
        };
        wake = take;
        take();
      });

    try {
      let outgoing: Uint8Array | null = handshake.start();
      while (outgoing) {
        await this.link.write(CHAR_AUTH, outgoing);
        outgoing = handshake.receive(await next());
      }
      this.session = handshake.session;
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      unsubscribe();
    }

    // Responses are needed for every command from here on.
    this.unsubscribeResponse = await this.link.subscribe(CHAR_RESPONSE, (bytes) => {
      const whole = this.responses.push(bytes);
      if (!whole) return;
      try {
        const r = decodeResponse(whole);
        const waiter = this.pending.get(r.seq);
        if (!waiter) return;
        this.pending.delete(r.seq);
        waiter.resolve({ status: r.status, payload: r.payload });
      } catch {
        // A frame we cannot read is dropped; the command times out and says so.
      }
    });
  }

  get authenticated(): boolean {
    return this.session !== null;
  }

  /** Step 3: frames, decoded into the app's shape. */
  async subscribeTelemetry(onSnapshot: (s: BatterySnapshot) => void): Promise<void> {
    if (!this.session) throw new GatewayError('Not authenticated');
    this.unsubscribeTelemetry = await this.link.subscribe(CHAR_TELEMETRY, (bytes) => {
      const whole = this.telemetry.push(bytes);
      if (!whole) return;
      try {
        onSnapshot(this.toSnapshot(decodeTelemetry(whole)));
      } catch (error) {
        if (!(error instanceof FrameError)) throw error;
      }
    });
  }

  toSnapshot(f: TelemetryFrame): BatterySnapshot {
    const cells = f.cellVoltages;
    const min = cells.length ? Math.min(...cells) : 0;
    const max = cells.length ? Math.max(...cells) : 0;
    return {
      timestamp: (this.options.now ?? Date.now)(),
      soc: f.soc,
      packVoltage: f.packVoltage,
      packCurrent: f.packCurrent,
      temperatures: f.temperatures,
      cellVoltages: cells,
      cellCount: cells.length,
      minCellV: min,
      maxCellV: max,
      deltaMv: Math.round((max - min) * 1000),
      chargeMos: f.chargeMos,
      dischargeMos: f.dischargeMos,
      balancing: f.balancing,
      balancingCells: f.balancingCells,
      faults: [
        ...decodeProtection(f.protection),
        ...(f.bmsUnreachable
          ? [{ code: 'BMS_UNREACHABLE', label: 'BMS not answering the gateway', level: 'Warning' as const }]
          : []),
      ],
      cycles: f.cycles,
      soh: f.soh,
      bmsModel: this.identity?.bmsModel ?? 'unknown',
      bmsFirmware: this.identity?.bmsFirmware ?? 'unknown',
      bleState: 'connected',
      location: null,
    };
  }

  private async command(opcode: number, payload: Uint8Array): Promise<{ status: number; payload: Uint8Array }> {
    if (!this.session) throw new GatewayError('Not authenticated');
    if (this.closed) throw new LinkLostError();
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xffff;
    const cmd = { opcode, seq, payload };
    const frame = encodeCommand(cmd, commandTag(this.session, commandBody(cmd)));

    const answer = new Promise<{ status: number; payload: Uint8Array }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new BmsTimeoutError());
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(seq, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
    await this.link.write(CHAR_COMMAND, frame);
    return answer;
  }

  /** In the app's display units. */
  async readParam(key: string): Promise<number> {
    const spec = paramByKey(key);
    if (!spec) throw new GatewayError(`No such parameter: ${key}`);
    const r = await this.command(OP.READ_PARAM, readParamPayload(spec.id));
    if (r.status === STATUS.BMS_TIMEOUT) throw new BmsTimeoutError();
    if (r.status !== STATUS.OK) throw new CommandRefusedError(r.status);
    return fromWire(spec, readI32(r.payload));
  }

  /**
   * Returns what the BMS holds afterwards. `adjusted` is true when that is
   * not what was asked; the caller decides what to say about it.
   */
  async writeParam(key: string, value: number): Promise<{ readBack: number; adjusted: boolean }> {
    const spec = paramByKey(key);
    if (!spec) throw new GatewayError(`No such parameter: ${key}`);
    if (!spec.writable) throw new CommandRefusedError(STATUS.READ_ONLY);
    const r = await this.command(OP.WRITE_PARAM, writeParamPayload(spec.id, toWire(spec, value)));
    if (r.status === STATUS.BMS_TIMEOUT) throw new BmsTimeoutError();
    if (r.status !== STATUS.OK && r.status !== STATUS.ADJUSTED) throw new CommandRefusedError(r.status);
    return { readBack: fromWire(spec, readI32(r.payload)), adjusted: r.status === STATUS.ADJUSTED };
  }

  private onLost(): void {
    this.closed = true;
    this.session = null;
    for (const waiter of this.pending.values()) waiter.reject(new LinkLostError());
    this.pending.clear();
    this.lostHandlers.forEach((h) => h());
  }

  private lostHandlers: (() => void)[] = [];
  onLostLink(handler: () => void): void {
    this.lostHandlers.push(handler);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeTelemetry?.();
    this.unsubscribeResponse?.();
    this.removeDisconnect?.();
    this.session = null;
    for (const waiter of this.pending.values()) waiter.reject(new LinkLostError());
    this.pending.clear();
    await this.link.disconnect().catch(() => undefined);
  }
}
