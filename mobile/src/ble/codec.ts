/**
 * The gateway wire format, as docs/BLE_CONTRACT.md defines it.
 *
 * Pure functions over byte arrays: nothing here touches a radio, so every
 * frame shape can be tested from the document. The firmware implements the
 * same document from the other side; if the two disagree, a test here fails
 * before a technician does.
 */

/* ------------------------------------------------------------------ UUIDs */

const BASE = (xx: string) => `7a3f00${xx}-3b7e-4d5b-9c1a-2f4e6d8a0b10`;

export const GATEWAY_SERVICE = BASE('01');
export const CHAR_IDENTITY = BASE('02');
export const CHAR_AUTH = BASE('03');
export const CHAR_TELEMETRY = BASE('04');
export const CHAR_COMMAND = BASE('05');
export const CHAR_RESPONSE = BASE('06');
export const CHAR_PROVISIONING = BASE('07');

export const PROTOCOL_VERSION = 1;
export const ADVERTISED_NAME_PREFIX = 'MEB-';
export const SETUP_NAME_PREFIX = 'MEB-SETUP-';

/* --------------------------------------------------------------- identity */

export interface Identity {
  protocolVersion: number;
  serial: string | null;
  hardwareRevision: string | null;
  firmwareVersion: string | null;
  bmsModel: string | null;
  bmsFirmware: string | null;
  cellCount: number | null;
  provisioned: boolean;
}

const decoder = new TextDecoder();

/** TLVs; unknown tags are skipped by length so a newer gateway still reads. */
export function decodeIdentity(bytes: Uint8Array): Identity {
  const out: Identity = {
    protocolVersion: 0,
    serial: null,
    hardwareRevision: null,
    firmwareVersion: null,
    bmsModel: null,
    bmsFirmware: null,
    cellCount: null,
    provisioned: false,
  };
  let at = 0;
  while (at + 2 <= bytes.length) {
    const tag = bytes[at]!;
    const length = bytes[at + 1]!;
    const value = bytes.subarray(at + 2, at + 2 + length);
    if (value.length < length) break; // truncated: stop rather than guess
    at += 2 + length;
    switch (tag) {
      case 0x01: out.protocolVersion = value[0] ?? 0; break;
      case 0x02: out.serial = decoder.decode(value); break;
      case 0x03: out.hardwareRevision = decoder.decode(value); break;
      case 0x04: out.firmwareVersion = decoder.decode(value); break;
      case 0x05: out.bmsModel = decoder.decode(value); break;
      case 0x06: out.bmsFirmware = decoder.decode(value); break;
      case 0x07: out.cellCount = value[0] ?? null; break;
      case 0x08: out.provisioned = value[0] === 1; break;
      default: break;
    }
  }
  return out;
}

/* -------------------------------------------------------------- telemetry */

export interface TelemetryFrame {
  seq: number;
  uptimeMs: number;
  chargeMos: boolean;
  dischargeMos: boolean;
  balancing: boolean;
  /** The BMS did not answer; the reading is the last good one, or zeros. */
  bmsUnreachable: boolean;
  /** V */
  packVoltage: number;
  /** A, positive charging */
  packCurrent: number;
  /** % */
  soc: number;
  /** % */
  soh: number;
  cycles: number;
  /** JBD protection bits, verbatim. */
  protection: number;
  /** 1-based cell numbers currently balancing. */
  balancingCells: number[];
  /** °C */
  temperatures: number[];
  /** V */
  cellVoltages: number[];
}

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

export function decodeTelemetry(bytes: Uint8Array): TelemetryFrame {
  if (bytes.length < 30) throw new FrameError(`Telemetry frame too short: ${bytes.length} bytes`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = v.getUint8(0);
  if (version !== PROTOCOL_VERSION) throw new FrameError(`Telemetry frame version ${version}, expected ${PROTOCOL_VERSION}`);
  const flags = v.getUint8(1);
  const ntcCount = v.getUint8(28);
  let at = 29;
  if (bytes.length < at + ntcCount * 2 + 1) throw new FrameError('Telemetry frame truncated in temperatures');
  const temperatures: number[] = [];
  for (let i = 0; i < ntcCount; i += 1, at += 2) temperatures.push(v.getInt16(at, true) / 10);
  const cellCount = v.getUint8(at);
  at += 1;
  if (bytes.length < at + cellCount * 2) throw new FrameError('Telemetry frame truncated in cells');
  const cellVoltages: number[] = [];
  for (let i = 0; i < cellCount; i += 1, at += 2) cellVoltages.push(v.getUint16(at, true) / 1000);

  const mask = v.getUint32(24, true);
  const balancingCells: number[] = [];
  for (let i = 0; i < 32; i += 1) if (mask & (1 << i)) balancingCells.push(i + 1);

  return {
    seq: v.getUint32(2, true),
    uptimeMs: v.getUint32(6, true),
    chargeMos: (flags & 0x01) !== 0,
    dischargeMos: (flags & 0x02) !== 0,
    balancing: (flags & 0x04) !== 0,
    bmsUnreachable: (flags & 0x08) !== 0,
    packVoltage: v.getUint16(10, true) / 100,
    packCurrent: v.getInt32(12, true) / 100,
    soc: v.getUint16(16, true) / 10,
    soh: v.getUint16(18, true) / 10,
    cycles: v.getUint16(20, true),
    protection: v.getUint16(22, true),
    balancingCells,
    temperatures,
    cellVoltages,
  };
}

/** For tests and the simulator: the inverse of decodeTelemetry. */
export function encodeTelemetry(f: TelemetryFrame): Uint8Array {
  const bytes = new Uint8Array(30 + f.temperatures.length * 2 + f.cellVoltages.length * 2);
  const v = new DataView(bytes.buffer);
  v.setUint8(0, PROTOCOL_VERSION);
  v.setUint8(
    1,
    (f.chargeMos ? 1 : 0) | (f.dischargeMos ? 2 : 0) | (f.balancing ? 4 : 0) | (f.bmsUnreachable ? 8 : 0)
  );
  v.setUint32(2, f.seq, true);
  v.setUint32(6, f.uptimeMs, true);
  v.setUint16(10, Math.round(f.packVoltage * 100), true);
  v.setInt32(12, Math.round(f.packCurrent * 100), true);
  v.setUint16(16, Math.round(f.soc * 10), true);
  v.setUint16(18, Math.round(f.soh * 10), true);
  v.setUint16(20, f.cycles, true);
  v.setUint16(22, f.protection, true);
  let mask = 0;
  for (const cell of f.balancingCells) mask |= 1 << (cell - 1);
  v.setUint32(24, mask >>> 0, true);
  v.setUint8(28, f.temperatures.length);
  let at = 29;
  for (const t of f.temperatures) { v.setInt16(at, Math.round(t * 10), true); at += 2; }
  v.setUint8(at, f.cellVoltages.length);
  at += 1;
  for (const c of f.cellVoltages) { v.setUint16(at, Math.round(c * 1000), true); at += 2; }
  return bytes;
}

/** §6.1, in the app's own fault vocabulary. Unknown bits become unnamed faults. */
export const PROTECTION_BITS: { bit: number; code: string; label: string; level: 'Warning' | 'Critical' }[] = [
  { bit: 0, code: 'COVP', label: 'Cell over-voltage', level: 'Critical' },
  { bit: 1, code: 'CUVP', label: 'Cell under-voltage', level: 'Critical' },
  { bit: 2, code: 'POVP', label: 'Pack over-voltage', level: 'Critical' },
  { bit: 3, code: 'PUVP', label: 'Pack under-voltage', level: 'Critical' },
  { bit: 4, code: 'CHGOT', label: 'Charge over-temperature', level: 'Warning' },
  { bit: 5, code: 'CHGUT', label: 'Charge under-temperature', level: 'Warning' },
  { bit: 6, code: 'DSGOT', label: 'Discharge over-temperature', level: 'Warning' },
  { bit: 7, code: 'DSGUT', label: 'Discharge under-temperature', level: 'Warning' },
  { bit: 8, code: 'CHGOC', label: 'Charge over-current', level: 'Critical' },
  { bit: 9, code: 'DSGOC', label: 'Discharge over-current', level: 'Critical' },
  { bit: 10, code: 'SC', label: 'Short circuit', level: 'Critical' },
  { bit: 11, code: 'IC', label: 'BMS IC error', level: 'Critical' },
  { bit: 12, code: 'MOSLOCK', label: 'MOS software lock', level: 'Warning' },
];

export function decodeProtection(bits: number): { code: string; label: string; level: 'Warning' | 'Critical' }[] {
  const out: { code: string; label: string; level: 'Warning' | 'Critical' }[] = [];
  for (let bit = 0; bit < 16; bit += 1) {
    if (!(bits & (1 << bit))) continue;
    const known = PROTECTION_BITS.find((p) => p.bit === bit);
    out.push(known ?? { code: `BIT${bit}`, label: `Protection bit ${bit}`, level: 'Warning' });
  }
  return out;
}

/* ----------------------------------------------------------- fragmentation */

/**
 * Reassembles §7.3 fragments. One instance per characteristic: a Telemetry
 * sequence and a Response sequence never interleave with each other, but
 * each may with itself if a frame was dropped, and a gap discards the lot.
 */
export class Reassembler {
  private parts: Uint8Array[] = [];
  private expected = 0;

  /** Returns the whole frame when the last fragment lands, else null. */
  push(fragment: Uint8Array): Uint8Array | null {
    if (fragment.length === 0) return null;
    const header = fragment[0]!;
    const index = header & 0x7f;
    const last = (header & 0x80) !== 0;
    if (index !== this.expected) {
      // A gap. Start again from whatever this is; a frame with a hole in it
      // is worse than a missed frame.
      this.parts = [];
      this.expected = 0;
      if (index !== 0) return null;
    }
    this.parts.push(fragment.subarray(1));
    this.expected += 1;
    if (!last) return null;
    const total = this.parts.reduce((n, p) => n + p.length, 0);
    const whole = new Uint8Array(total);
    let at = 0;
    for (const p of this.parts) { whole.set(p, at); at += p.length; }
    this.parts = [];
    this.expected = 0;
    return whole;
  }
}

/** The gateway's side of §7.3, for the simulator and tests. */
export function fragment(frame: Uint8Array, mtu: number): Uint8Array[] {
  const chunk = Math.max(1, mtu - 3 - 1);
  const out: Uint8Array[] = [];
  const count = Math.max(1, Math.ceil(frame.length / chunk));
  for (let i = 0; i < count; i += 1) {
    const body = frame.subarray(i * chunk, (i + 1) * chunk);
    const piece = new Uint8Array(1 + body.length);
    piece[0] = (i === count - 1 ? 0x80 : 0) | i;
    piece.set(body, 1);
    out.push(piece);
  }
  return out;
}

/* --------------------------------------------------------------- commands */

export const OP = {
  READ_PARAM: 0x10,
  WRITE_PARAM: 0x11,
  READ_ALL_PARAMS: 0x12,
} as const;

export const STATUS = {
  OK: 0x00,
  UNKNOWN_PARAM: 0x01,
  READ_ONLY: 0x02,
  OUT_OF_RANGE: 0x03,
  BMS_TIMEOUT: 0x04,
  NOT_AUTHENTICATED: 0x05,
  BAD_TAG: 0x06,
  BUSY: 0x07,
  ADJUSTED: 0x08,
} as const;
export type Status = (typeof STATUS)[keyof typeof STATUS];

export const STATUS_LABEL: Record<number, string> = {
  0x00: 'ok',
  0x01: 'the gateway does not know that parameter',
  0x02: 'that parameter is fixed by the hardware',
  0x03: 'the BMS refused the value',
  0x04: 'the BMS did not answer',
  0x05: 'the link is not authenticated',
  0x06: 'the command was not accepted (bad tag)',
  0x07: 'the gateway is busy',
  0x08: 'the BMS applied a different value',
};

/**
 * §7.4. `scale` is wire units per display unit: a value the app shows as
 * 3.75 V crosses the wire as 3750 mV. Everything the app displays comes from
 * the capability profile; this only says how to carry it.
 */
export interface ParamSpec {
  id: number;
  key: string;
  scale: number;
  writable: boolean;
}

export const PARAMS: ParamSpec[] = [
  { id: 0x01, key: 'cell_ovp', scale: 1000, writable: true },
  { id: 0x02, key: 'cell_ovp_release', scale: 1000, writable: true },
  { id: 0x03, key: 'cell_uvp', scale: 1000, writable: true },
  { id: 0x04, key: 'cell_uvp_release', scale: 1000, writable: true },
  { id: 0x05, key: 'cell_ovp_delay', scale: 1, writable: true },
  { id: 0x06, key: 'cell_uvp_delay', scale: 1, writable: true },
  { id: 0x10, key: 'charge_ocp', scale: 1000, writable: false },
  { id: 0x11, key: 'charge_ocp_delay', scale: 1, writable: true },
  { id: 0x12, key: 'discharge_ocp_1', scale: 1000, writable: false },
  { id: 0x13, key: 'discharge_ocp_1_delay', scale: 1, writable: true },
  { id: 0x14, key: 'discharge_ocp_2', scale: 1000, writable: false },
  { id: 0x15, key: 'discharge_ocp_2_delay', scale: 1, writable: true },
  { id: 0x16, key: 'short_circuit', scale: 1000, writable: false },
  { id: 0x17, key: 'short_circuit_delay', scale: 1, writable: true },
  { id: 0x20, key: 'charge_htp', scale: 10, writable: true },
  { id: 0x21, key: 'charge_htp_release', scale: 10, writable: true },
  { id: 0x22, key: 'charge_ltp', scale: 10, writable: true },
  { id: 0x23, key: 'charge_ltp_release', scale: 10, writable: true },
  { id: 0x24, key: 'discharge_htp', scale: 10, writable: true },
  { id: 0x25, key: 'discharge_htp_release', scale: 10, writable: true },
  { id: 0x26, key: 'discharge_ltp', scale: 10, writable: true },
  { id: 0x27, key: 'discharge_ltp_release', scale: 10, writable: true },
  { id: 0x28, key: 'fet_htp', scale: 10, writable: true },
  { id: 0x29, key: 'fet_htp_release', scale: 10, writable: true },
  { id: 0x30, key: 'balance_start_v', scale: 1000, writable: true },
  { id: 0x31, key: 'balance_delta_mv', scale: 1, writable: true },
  { id: 0x32, key: 'balance_current_ma', scale: 1, writable: false },
  { id: 0x40, key: 'cell_count', scale: 1, writable: false },
  { id: 0x41, key: 'capacity_ah', scale: 1000, writable: true },
];

export const paramByKey = (key: string): ParamSpec | undefined => PARAMS.find((p) => p.key === key);
export const paramById = (id: number): ParamSpec | undefined => PARAMS.find((p) => p.id === id);

export interface Command {
  opcode: number;
  seq: number;
  payload: Uint8Array;
}

/** The bytes a tag covers: opcode ‖ seq ‖ payload. */
export function commandBody(c: Command): Uint8Array {
  const out = new Uint8Array(3 + c.payload.length);
  out[0] = c.opcode;
  new DataView(out.buffer).setUint16(1, c.seq, true);
  out.set(c.payload, 3);
  return out;
}

/** body ‖ tag, where the caller has computed the 16-byte tag over the body. */
export function encodeCommand(c: Command, tag16: Uint8Array): Uint8Array {
  if (tag16.length !== 16) throw new FrameError('Command tag must be 16 bytes');
  const body = commandBody(c);
  const out = new Uint8Array(body.length + 16);
  out.set(body);
  out.set(tag16, body.length);
  return out;
}

export const readParamPayload = (paramId: number): Uint8Array => new Uint8Array([paramId]);

export function writeParamPayload(paramId: number, wireValue: number): Uint8Array {
  const out = new Uint8Array(5);
  out[0] = paramId;
  new DataView(out.buffer).setInt32(1, wireValue, true);
  return out;
}

export interface Response {
  opcode: number;
  seq: number;
  status: number;
  payload: Uint8Array;
}

export function decodeResponse(bytes: Uint8Array): Response {
  if (bytes.length < 4) throw new FrameError(`Response too short: ${bytes.length} bytes`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    opcode: bytes[0]! & 0x7f,
    seq: v.getUint16(1, true),
    status: bytes[3]!,
    payload: bytes.subarray(4),
  };
}

/** For the simulator and tests. */
export function encodeResponse(r: Response): Uint8Array {
  const out = new Uint8Array(4 + r.payload.length);
  out[0] = r.opcode | 0x80;
  new DataView(out.buffer).setUint16(1, r.seq, true);
  out[3] = r.status;
  out.set(r.payload, 4);
  return out;
}

export function readI32(payload: Uint8Array, at = 0): number {
  if (payload.length < at + 4) throw new FrameError('Response payload too short for a value');
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getInt32(at, true);
}

/** Display units ↔ wire units, with the rounding a BMS register implies. */
export const toWire = (spec: ParamSpec, value: number): number => Math.round(value * spec.scale);
export const fromWire = (spec: ParamSpec, wire: number): number => wire / spec.scale;
