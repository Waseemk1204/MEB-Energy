/**
 * A gateway in software, behind the GattLink interface.
 *
 * It does what the firmware does -- identity, the §5 handshake, tagged
 * commands against a register table, telemetry frames, fragmentation at the
 * MTU -- so the client can be tested end to end without a board, and so the
 * app can be run against a pack that does not exist. Not a physics model: the
 * MockSource is that. This one is about the protocol.
 */
import { GatewayHandshake, commandTag } from './auth';
import {
  CHAR_AUTH,
  CHAR_COMMAND,
  CHAR_IDENTITY,
  CHAR_RESPONSE,
  CHAR_TELEMETRY,
  OP,
  PARAMS,
  STATUS,
  commandBody,
  encodeResponse,
  encodeTelemetry,
  fragment,
  paramById,
  readI32,
  type TelemetryFrame,
} from './codec';
import { bytesEqual, utf8 } from './sha256';
import type { GattLink } from './link';

export interface FakeGatewayOptions {
  serial: string;
  key: Uint8Array | null;
  mtu?: number;
  bmsModel?: string;
  cellCount?: number;
  random?: (n: number) => Uint8Array;
  /** Register values in wire units, by parameter id. */
  registers?: Map<number, number>;
  /** Make the BMS refuse a value (OUT_OF_RANGE) when this returns true. */
  refuse?: (paramId: number, wire: number) => boolean;
  /** Make the BMS clamp a written value, to test ADJUSTED. */
  clamp?: (paramId: number, wire: number) => number;
  /** Make a command go unanswered, to test BMS_TIMEOUT. */
  silent?: (paramId: number) => boolean;
}

export class FakeGatewayLink implements GattLink {
  readonly id: string;
  readonly name: string;
  private connected = false;
  private listeners = new Map<string, (bytes: Uint8Array) => void>();
  private disconnectHandlers: (() => void)[] = [];
  private handshake: GatewayHandshake;
  private telemetrySeq = 0;
  readonly registers: Map<number, number>;
  /** Every command frame the gateway saw, for assertions. */
  readonly commands: Uint8Array[] = [];

  constructor(readonly options: FakeGatewayOptions) {
    this.id = `fake-${options.serial}`;
    this.name = `MEB-${options.serial.slice(-6)}`;
    this.handshake = new GatewayHandshake(
      options.key,
      options.serial,
      options.random ?? ((n) => new Uint8Array(n).map((_, i) => (i * 37 + 11) & 0xff))
    );
    this.registers = options.registers ?? new Map(PARAMS.map((p) => [p.id, 0]));
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    this.handshake = new GatewayHandshake(this.options.key, this.options.serial, this.options.random ?? ((n) => new Uint8Array(n)));
    this.disconnectHandlers.splice(0).forEach((h) => h());
  }

  /** The gateway side dropping the link. */
  drop(): void {
    void this.disconnect();
  }

  mtu(): number {
    return this.options.mtu ?? 247;
  }

  onDisconnected(handler: () => void): () => void {
    this.disconnectHandlers.push(handler);
    return () => {
      this.disconnectHandlers = this.disconnectHandlers.filter((h) => h !== handler);
    };
  }

  async read(characteristic: string): Promise<Uint8Array> {
    if (!this.connected) throw new Error('not connected');
    if (characteristic !== CHAR_IDENTITY) throw new Error(`cannot read ${characteristic}`);
    const tlv = (tag: number, value: Uint8Array) => new Uint8Array([tag, value.length, ...value]);
    const parts = [
      tlv(0x01, new Uint8Array([1])),
      ...(this.options.key ? [tlv(0x02, utf8(this.options.serial))] : []),
      tlv(0x03, utf8('HW 1.0')),
      tlv(0x04, utf8('FW 1.0.0')),
      ...(this.options.bmsModel === null ? [] : [tlv(0x05, utf8(this.options.bmsModel ?? 'JBD SP24S004')), tlv(0x06, utf8('1.2'))]),
      tlv(0x07, new Uint8Array([this.options.cellCount ?? 24])),
      tlv(0x08, new Uint8Array([this.options.key ? 1 : 0])),
    ];
    return new Uint8Array(parts.flatMap((p) => [...p]));
  }

  async subscribe(characteristic: string, onValue: (bytes: Uint8Array) => void): Promise<() => void> {
    if (!this.connected) throw new Error('not connected');
    this.listeners.set(characteristic, onValue);
    return () => {
      if (this.listeners.get(characteristic) === onValue) this.listeners.delete(characteristic);
    };
  }

  private notify(characteristic: string, frame: Uint8Array): void {
    const listener = this.listeners.get(characteristic);
    if (!listener) return;
    // Auth replies are short and never fragmented; the others go by §7.3.
    if (characteristic === CHAR_AUTH) {
      listener(frame);
      return;
    }
    for (const piece of fragment(frame, this.mtu())) listener(piece);
  }

  async write(characteristic: string, bytes: Uint8Array): Promise<void> {
    if (!this.connected) throw new Error('not connected');
    if (characteristic === CHAR_AUTH) {
      const reply = this.handshake.receive(bytes);
      this.notify(CHAR_AUTH, reply);
      if (reply[0] === 0x04 && reply[1] !== 0x00 && bytes[0] === 0x03) this.drop();
      return;
    }
    if (characteristic === CHAR_COMMAND) {
      this.commands.push(bytes);
      this.handleCommand(bytes);
      return;
    }
    throw new Error(`cannot write ${characteristic}`);
  }

  private handleCommand(bytes: Uint8Array): void {
    if (bytes.length < 19) return;
    const opcode = bytes[0]!;
    const seq = bytes[1]! | (bytes[2]! << 8);
    const payload = bytes.subarray(3, bytes.length - 16);
    const tag = bytes.subarray(bytes.length - 16);
    const answer = (status: number, body: Uint8Array = new Uint8Array(0)) =>
      this.notify(CHAR_RESPONSE, encodeResponse({ opcode, seq, status, payload: body }));

    if (!this.handshake.session) return answer(STATUS.NOT_AUTHENTICATED);
    const expected = commandTag(this.handshake.session, commandBody({ opcode, seq, payload }));
    if (!bytesEqual(tag, expected)) return answer(STATUS.BAD_TAG);

    const i32 = (v: number) => {
      const out = new Uint8Array(4);
      new DataView(out.buffer).setInt32(0, v, true);
      return out;
    };

    if (opcode === OP.READ_PARAM) {
      const spec = paramById(payload[0] ?? -1);
      if (!spec) return answer(STATUS.UNKNOWN_PARAM);
      if (this.options.silent?.(spec.id)) return;
      return answer(STATUS.OK, i32(this.registers.get(spec.id) ?? 0));
    }
    if (opcode === OP.WRITE_PARAM) {
      const spec = paramById(payload[0] ?? -1);
      if (!spec) return answer(STATUS.UNKNOWN_PARAM);
      if (!spec.writable) return answer(STATUS.READ_ONLY);
      const wire = readI32(payload, 1);
      if (this.options.silent?.(spec.id)) return;
      if (this.options.refuse?.(spec.id, wire)) return answer(STATUS.OUT_OF_RANGE, i32(this.registers.get(spec.id) ?? 0));
      const stored = this.options.clamp ? this.options.clamp(spec.id, wire) : wire;
      this.registers.set(spec.id, stored);
      return answer(stored === wire ? STATUS.OK : STATUS.ADJUSTED, i32(stored));
    }
    return answer(STATUS.UNKNOWN_PARAM);
  }

  /** Push one telemetry frame to a subscribed, authenticated central. */
  emit(frame: Partial<TelemetryFrame> = {}): void {
    if (!this.handshake.session) return;
    const cells = this.options.cellCount ?? 24;
    const full: TelemetryFrame = {
      seq: ++this.telemetrySeq,
      uptimeMs: this.telemetrySeq * 500,
      chargeMos: true,
      dischargeMos: true,
      balancing: false,
      bmsUnreachable: false,
      packVoltage: 79.2,
      packCurrent: -12,
      soc: 72,
      soh: 98,
      cycles: 120,
      protection: 0,
      balancingCells: [],
      temperatures: [24, 26],
      cellVoltages: Array.from({ length: cells }, () => 3.3),
      ...frame,
    };
    this.notify(CHAR_TELEMETRY, encodeTelemetry(full));
  }

  get authorised(): boolean {
    return this.handshake.session !== null;
  }
}
