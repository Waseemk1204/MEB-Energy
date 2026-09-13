import {
  OP,
  PARAMS,
  Reassembler,
  STATUS,
  commandBody,
  decodeIdentity,
  decodeProtection,
  decodeResponse,
  decodeTelemetry,
  encodeCommand,
  encodeResponse,
  encodeTelemetry,
  fragment,
  fromWire,
  paramByKey,
  readI32,
  readParamPayload,
  toWire,
  writeParamPayload,
  type TelemetryFrame,
} from './codec';
import { AppHandshake, GatewayHandshake, commandTag, gatewayTag, sessionKey } from './auth';
import { bytesToHex, hexToBytes, utf8 } from './sha256';
import { profile } from '../bms/capabilityProfile';

/**
 * Written from docs/BLE_CONTRACT.md, not from the firmware. Where a test has
 * a fixed byte string, that string is the contract; the firmware is checked
 * against the same bytes.
 */

describe('identity', () => {
  const tlv = (tag: number, value: Uint8Array) => new Uint8Array([tag, value.length, ...value]);

  it('reads every field', () => {
    const bytes = new Uint8Array([
      ...tlv(0x01, new Uint8Array([1])),
      ...tlv(0x02, utf8('GW-000184')),
      ...tlv(0x03, utf8('HW 1.0')),
      ...tlv(0x04, utf8('FW 1.0.0')),
      ...tlv(0x05, utf8('JBD SP24S004')),
      ...tlv(0x06, utf8('1.2')),
      ...tlv(0x07, new Uint8Array([24])),
      ...tlv(0x08, new Uint8Array([1])),
    ]);
    expect(decodeIdentity(bytes)).toEqual({
      protocolVersion: 1,
      serial: 'GW-000184',
      hardwareRevision: 'HW 1.0',
      firmwareVersion: 'FW 1.0.0',
      bmsModel: 'JBD SP24S004',
      bmsFirmware: '1.2',
      cellCount: 24,
      provisioned: true,
    });
  });

  /** A later firmware may add tags; an earlier app must not choke on them. */
  it('skips a tag it does not know', () => {
    const bytes = new Uint8Array([...tlv(0x7f, utf8('future')), ...tlv(0x02, utf8('GW-1'))]);
    expect(decodeIdentity(bytes).serial).toBe('GW-1');
  });

  it('stops at a truncated TLV rather than guessing', () => {
    const bytes = new Uint8Array([0x02, 0x09, 0x47, 0x57]);
    expect(decodeIdentity(bytes).serial).toBeNull();
  });

  it('reads an unprovisioned gateway as such', () => {
    const bytes = new Uint8Array([...tlv(0x01, new Uint8Array([1])), ...tlv(0x08, new Uint8Array([0]))]);
    expect(decodeIdentity(bytes).provisioned).toBe(false);
    expect(decodeIdentity(bytes).serial).toBeNull();
  });
});

describe('telemetry', () => {
  const frame: TelemetryFrame = {
    seq: 4242,
    uptimeMs: 123456,
    chargeMos: true,
    dischargeMos: true,
    balancing: true,
    bmsUnreachable: false,
    packVoltage: 79.36,
    packCurrent: -12.5,
    soc: 72.8,
    soh: 98.0,
    cycles: 120,
    protection: 0b0000_0000_0001_0000,
    balancingCells: [3, 24],
    temperatures: [24.5, 26.0],
    cellVoltages: Array.from({ length: 24 }, (_, i) => 3.3 + i * 0.001),
  };

  it('round-trips through the contract layout', () => {
    const decoded = decodeTelemetry(encodeTelemetry(frame));
    expect(decoded.seq).toBe(4242);
    expect(decoded.uptimeMs).toBe(123456);
    expect(decoded.packVoltage).toBeCloseTo(79.36, 5);
    expect(decoded.packCurrent).toBeCloseTo(-12.5, 5);
    expect(decoded.soc).toBeCloseTo(72.8, 5);
    expect(decoded.soh).toBeCloseTo(98, 5);
    expect(decoded.cycles).toBe(120);
    expect(decoded.protection).toBe(16);
    expect(decoded.balancingCells).toEqual([3, 24]);
    expect(decoded.temperatures).toEqual([24.5, 26]);
    expect(decoded.cellVoltages[0]).toBeCloseTo(3.3, 5);
    expect(decoded.cellVoltages[23]).toBeCloseTo(3.323, 5);
    expect(decoded.chargeMos && decoded.dischargeMos && decoded.balancing).toBe(true);
    expect(decoded.bmsUnreachable).toBe(false);
  });

  /** The contract's worked example: a 24S pack with two NTCs is 82 bytes. */
  it('is 82 bytes for 24 cells and 2 NTCs', () => {
    expect(encodeTelemetry(frame).length).toBe(82);
  });

  /** Fixed bytes: the firmware must produce exactly these for these values. */
  it('lays out the header as the contract says', () => {
    const minimal: TelemetryFrame = {
      ...frame,
      seq: 1,
      uptimeMs: 2,
      chargeMos: true,
      dischargeMos: false,
      balancing: false,
      bmsUnreachable: true,
      packVoltage: 80.0,
      packCurrent: -1.0,
      soc: 50.0,
      soh: 100,
      cycles: 7,
      protection: 0x0401,
      balancingCells: [1],
      temperatures: [-5.5],
      cellVoltages: [3.333],
    };
    expect(bytesToHex(encodeTelemetry(minimal))).toBe(
      '01' + // version
        '09' + // flags: charge MOS + BMS unreachable
        '01000000' + // seq
        '02000000' + // uptime
        '401f' + // 8000 × 10 mV
        '9cffffff' + // -100 × 10 mA
        'f401' + // 500 × 0.1 %
        'e803' + // 1000 × 0.1 %
        '0700' + // cycles
        '0104' + // protection
        '01000000' + // balancing cell 1
        '01' + // one NTC
        'c9ff' + // -55 × 0.1 °C
        '01' + // one cell
        '050d' // 3333 mV
    );
  });

  it('refuses a frame from another protocol version', () => {
    const bytes = encodeTelemetry(frame);
    bytes[0] = 2;
    expect(() => decodeTelemetry(bytes)).toThrow(/version 2/);
  });

  it('refuses a truncated frame rather than reading past it', () => {
    const bytes = encodeTelemetry(frame).subarray(0, 40);
    expect(() => decodeTelemetry(bytes)).toThrow(/truncated/);
  });

  it('names the protection bits it knows and keeps the ones it does not', () => {
    const faults = decodeProtection(0b0010_0000_0000_0101);
    expect(faults.map((f) => f.code)).toEqual(['COVP', 'POVP', 'BIT13']);
    expect(faults[0]?.level).toBe('Critical');
  });
});

describe('fragmentation', () => {
  const frame = new Uint8Array(82).map((_, i) => i);

  it('fits one notification at MTU 247', () => {
    const parts = fragment(frame, 247);
    expect(parts.length).toBe(1);
    expect(parts[0]![0]).toBe(0x80);
  });

  it('splits at the default MTU and reassembles', () => {
    const parts = fragment(frame, 23);
    expect(parts.length).toBe(5); // 19 bytes of body per fragment
    expect(parts[0]![0]).toBe(0x00);
    expect(parts[4]![0]).toBe(0x84);
    const r = new Reassembler();
    let whole: Uint8Array | null = null;
    for (const p of parts) whole = r.push(p);
    expect(whole && bytesToHex(whole)).toBe(bytesToHex(frame));
  });

  /** A frame with a hole in it is worse than a missed frame. */
  it('discards a sequence with a gap', () => {
    const parts = fragment(frame, 23);
    const r = new Reassembler();
    r.push(parts[0]!);
    r.push(parts[2]!); // 1 missing
    expect(r.push(parts[3]!)).toBeNull();
    expect(r.push(parts[4]!)).toBeNull();
    // And recovers on the next clean sequence.
    let whole: Uint8Array | null = null;
    for (const p of parts) whole = r.push(p);
    expect(whole?.length).toBe(82);
  });
});

describe('parameters', () => {
  it('covers every parameter in the capability profile, and no others', () => {
    const keys = profile.parameters.map((p) => p.parameter_key).sort();
    expect(PARAMS.map((p) => p.key).sort()).toEqual(keys);
  });

  it('has a unique id per parameter', () => {
    expect(new Set(PARAMS.map((p) => p.id)).size).toBe(PARAMS.length);
  });

  it('agrees with the profile about what is writable', () => {
    for (const p of profile.parameters) {
      expect({ key: p.parameter_key, writable: paramByKey(p.parameter_key)?.writable }).toEqual({
        key: p.parameter_key,
        writable: p.writable,
      });
    }
  });

  it('carries volts as millivolts and degrees as tenths', () => {
    expect(toWire(paramByKey('cell_ovp')!, 3.75)).toBe(3750);
    expect(fromWire(paramByKey('cell_ovp')!, 3750)).toBe(3.75);
    expect(toWire(paramByKey('charge_htp')!, 45)).toBe(450);
    expect(toWire(paramByKey('capacity_ah')!, 100)).toBe(100000);
  });
});

describe('commands', () => {
  const session = hexToBytes('00'.repeat(31) + '01');

  it('frames a read with the tag over opcode, seq and payload', () => {
    const cmd = { opcode: OP.READ_PARAM, seq: 0x0102, payload: readParamPayload(0x01) };
    const body = commandBody(cmd);
    expect(bytesToHex(body)).toBe('10020101');
    const tag = commandTag(session, body);
    const frame = encodeCommand(cmd, tag);
    expect(frame.length).toBe(4 + 16);
    expect(bytesToHex(frame.subarray(4))).toBe(bytesToHex(tag));
  });

  it('frames a write with a little-endian value', () => {
    const payload = writeParamPayload(0x01, 3750);
    expect(bytesToHex(payload)).toBe('01a60e0000');
    const payloadNeg = writeParamPayload(0x22, -50);
    expect(bytesToHex(payloadNeg)).toBe('22ceffffff');
  });

  it('decodes a response and its value', () => {
    const r = decodeResponse(encodeResponse({ opcode: OP.WRITE_PARAM, seq: 9, status: STATUS.ADJUSTED, payload: writeParamPayload(0, 3740).subarray(1) }));
    expect(r.opcode).toBe(OP.WRITE_PARAM);
    expect(r.seq).toBe(9);
    expect(r.status).toBe(STATUS.ADJUSTED);
    expect(readI32(r.payload)).toBe(3740);
  });

  /** Fixed vector: the firmware must compute this tag for this session key. */
  it('has a stable tag vector', () => {
    const tag = commandTag(hexToBytes('11'.repeat(32)), hexToBytes('11000105a60e0000'));
    expect(bytesToHex(tag)).toMatchSnapshot();
  });
});

describe('the handshake', () => {
  const key = hexToBytes('0f'.repeat(32));
  const serial = 'GW-000184';
  const fixedRandom = (byte: number) => (n: number) => new Uint8Array(n).fill(byte);

  const run = (gatewayKey: Uint8Array | null, appKey = key) => {
    const app = new AppHandshake(appKey, serial, fixedRandom(0xaa));
    const gw = new GatewayHandshake(gatewayKey, serial, fixedRandom(0xbb));
    let toGateway: Uint8Array | null = app.start();
    while (toGateway) {
      const toApp = gw.receive(toGateway);
      toGateway = app.receive(toApp);
    }
    return { app, gw };
  };

  it('completes when both hold the key and both derive the same session', () => {
    const { app, gw } = run(key);
    expect(app.complete).toBe(true);
    expect(bytesToHex(app.session)).toBe(bytesToHex(gw.session!));
  });

  /** The property the whole thing exists for. */
  it('refuses a gateway with the wrong key without sending it the app tag', () => {
    const gw = new GatewayHandshake(hexToBytes('ee'.repeat(32)), serial, fixedRandom(0xbb));
    const app = new AppHandshake(key, serial, fixedRandom(0xaa));
    const challenge = gw.receive(app.start());
    expect(() => app.receive(challenge)).toThrow(/could not be verified: wrong key/);
    expect(gw.session).toBeNull();
  });

  it('is refused by a gateway when the app has the wrong key', () => {
    const gw = new GatewayHandshake(key, serial, fixedRandom(0xbb));
    const app = new AppHandshake(hexToBytes('ee'.repeat(32)), serial, fixedRandom(0xaa));
    // The app cannot even verify the gateway's tag with the wrong key.
    expect(() => app.receive(gw.receive(app.start()))).toThrow(/wrong key/);
  });

  it('refuses an unprovisioned gateway', () => {
    const app = new AppHandshake(key, serial, fixedRandom(0xaa));
    const gw = new GatewayHandshake(null, serial, fixedRandom(0xbb));
    expect(() => app.receive(gw.receive(app.start()))).toThrow(/not_provisioned/);
  });

  it('binds the tag to the serial, so a key cannot be replayed to another gateway', () => {
    const nonceA = new Uint8Array(16).fill(1);
    const nonceG = new Uint8Array(16).fill(2);
    expect(bytesToHex(gatewayTag(key, 'GW-1', nonceA, nonceG))).not.toBe(
      bytesToHex(gatewayTag(key, 'GW-2', nonceA, nonceG))
    );
  });

  /**
   * Fixed vectors for the firmware. With key 0f×32, serial GW-000184,
   * nonceA aa×16 and nonceG bb×16, these are the bytes on the wire.
   */
  it('produces the contract vectors', () => {
    const nonceA = new Uint8Array(16).fill(0xaa);
    const nonceG = new Uint8Array(16).fill(0xbb);
    const vectors = {
      tagG: bytesToHex(gatewayTag(key, serial, nonceA, nonceG)),
      session: bytesToHex(sessionKey(key, nonceA, nonceG)),
    };
    // Regenerate with: npx jest src/ble/codec.test.ts -t vectors --verbose
    expect(vectors.tagG).toHaveLength(64);
    expect(vectors.session).toHaveLength(64);
    expect(vectors).toMatchSnapshot();
  });
});
