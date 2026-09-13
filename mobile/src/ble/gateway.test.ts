import { BmsTimeoutError, CommandRefusedError, GatewayClient, GatewayError } from './gateway';
import { FakeGatewayLink } from './fakeGateway';
import { GatewayUnverifiedError } from './auth';
import { LinkLostError } from './link';
import { hexToBytes } from './sha256';
import { paramByKey } from './codec';
import type { BatterySnapshot } from '../telemetry/types';

/**
 * The client against a gateway in software that does what the firmware
 * does. Every rule in docs/BLE_CONTRACT.md that the app has to hold up is
 * here; the firmware's host tests hold up the other side.
 */

const KEY = hexToBytes('0f'.repeat(32));
const random = (n: number) => new Uint8Array(n).map((_, i) => (i * 7 + 3) & 0xff);

const open = async (options: Partial<ConstructorParameters<typeof FakeGatewayLink>[0]> = {}) => {
  const link = new FakeGatewayLink({ serial: 'GW-000184', key: KEY, ...options });
  const client = new GatewayClient(link, { random, now: () => 1_000 });
  return { link, client };
};

describe('opening', () => {
  it('reads identity before trusting anything', async () => {
    const { client } = await open();
    const id = await client.open();
    expect(id.serial).toBe('GW-000184');
    expect(id.bmsModel).toBe('JBD SP24S004');
    expect(client.authenticated).toBe(false);
  });

  it('refuses a gateway speaking another protocol version', async () => {
    const { link, client } = await open();
    const original = link.read.bind(link);
    link.read = async (c) => {
      const bytes = await original(c);
      bytes[2] = 9; // the version TLV's value
      return bytes;
    };
    await expect(client.open()).rejects.toThrow(/protocol 9/);
  });
});

describe('authenticating', () => {
  it('completes with the right key and unlocks commands', async () => {
    const { link, client } = await open();
    await client.open();
    await client.authenticate(KEY);
    expect(client.authenticated).toBe(true);
    expect(link.authorised).toBe(true);
  });

  /** The rule the whole thing exists for. */
  it('walks away from a gateway with the wrong key, and reads nothing from it', async () => {
    const { link, client } = await open({ key: hexToBytes('ee'.repeat(32)) });
    await client.open();
    await expect(client.authenticate(KEY)).rejects.toThrow(GatewayUnverifiedError);
    expect(client.authenticated).toBe(false);
    expect(link.commands).toHaveLength(0);
    // And the link is closed: the fake reports disconnect.
    await expect(client.readParam('cell_ovp')).rejects.toThrow();
  });

  it('refuses to authenticate an unprovisioned gateway', async () => {
    const { client } = await open({ key: null });
    await client.open();
    await expect(client.authenticate(KEY)).rejects.toThrow(/not provisioned/);
  });

  it('will not issue a command before authenticating', async () => {
    const { client } = await open();
    await client.open();
    await expect(client.readParam('cell_ovp')).rejects.toThrow(GatewayError);
  });
});

describe('telemetry', () => {
  const linked = async (mtu?: number) => {
    const { link, client } = await open({ mtu });
    await client.open();
    await client.authenticate(KEY);
    const frames: BatterySnapshot[] = [];
    await client.subscribeTelemetry((s) => frames.push(s));
    return { link, client, frames };
  };

  it('turns a frame into a snapshot with derived cell figures', async () => {
    const { link, frames } = await linked();
    link.emit({ cellVoltages: [3.301, 3.35, 3.28], packCurrent: -12.5, soc: 72 });
    expect(frames).toHaveLength(1);
    const s = frames[0]!;
    expect(s.cellCount).toBe(3);
    expect(s.minCellV).toBeCloseTo(3.28, 5);
    expect(s.maxCellV).toBeCloseTo(3.35, 5);
    expect(s.deltaMv).toBe(70);
    expect(s.packCurrent).toBeCloseTo(-12.5, 5);
    expect(s.soc).toBe(72);
    expect(s.bmsModel).toBe('JBD SP24S004');
    expect(s.bleState).toBe('connected');
    expect(s.location).toBeNull();
    expect(s.timestamp).toBe(1_000);
  });

  it('reassembles fragments at the default MTU', async () => {
    const { link, frames } = await linked(23);
    link.emit();
    link.emit();
    expect(frames).toHaveLength(2);
    expect(frames[1]!.cellCount).toBe(24);
  });

  it('names tripped protections as faults', async () => {
    const { link, frames } = await linked();
    link.emit({ protection: 0b1_0000_0001 }); // COVP + CHGOC
    expect(frames[0]!.faults.map((f) => f.code)).toEqual(['COVP', 'CHGOC']);
    expect(frames[0]!.faults[0]!.level).toBe('Critical');
  });

  it('reports a BMS the gateway cannot reach as a fault, not as silence', async () => {
    const { link, frames } = await linked();
    link.emit({ bmsUnreachable: true });
    expect(frames[0]!.faults.map((f) => f.code)).toEqual(['BMS_UNREACHABLE']);
  });
});

describe('parameters', () => {
  const linked = async (options: Partial<ConstructorParameters<typeof FakeGatewayLink>[0]> = {}) => {
    const { link, client } = await open(options);
    await client.open();
    await client.authenticate(KEY);
    return { link, client };
  };

  it('reads a value in display units', async () => {
    const { link, client } = await linked();
    link.registers.set(paramByKey('cell_ovp')!.id, 3750);
    link.registers.set(paramByKey('charge_htp')!.id, 450);
    expect(await client.readParam('cell_ovp')).toBe(3.75);
    expect(await client.readParam('charge_htp')).toBe(45);
  });

  it('writes and reports what the BMS holds', async () => {
    const { link, client } = await linked();
    const r = await client.writeParam('cell_ovp', 3.78);
    expect(r).toEqual({ readBack: 3.78, adjusted: false });
    expect(link.registers.get(paramByKey('cell_ovp')!.id)).toBe(3780);
  });

  it('says so when the BMS stored something else', async () => {
    const { client } = await linked({ clamp: (_id, wire) => Math.min(wire, 3700) });
    const r = await client.writeParam('cell_ovp', 3.78);
    expect(r).toEqual({ readBack: 3.7, adjusted: true });
  });

  it('refuses a read-only parameter without asking the gateway', async () => {
    const { link, client } = await linked();
    await expect(client.writeParam('charge_ocp', 100)).rejects.toThrow(CommandRefusedError);
    expect(link.commands).toHaveLength(0);
  });

  it('reports a BMS refusal as refused', async () => {
    const { client } = await linked({ refuse: () => true });
    await expect(client.writeParam('cell_ovp', 4.3)).rejects.toThrow(/refused the value/);
  });

  it('reports a silent BMS as a timeout, not a refusal', async () => {
    jest.useFakeTimers();
    try {
      const { client } = await linked({ silent: () => true });
      const pending = client.writeParam('cell_ovp', 3.7);
      const expectation = expect(pending).rejects.toThrow(BmsTimeoutError);
      jest.advanceTimersByTime(7000);
      await expectation;
    } finally {
      jest.useRealTimers();
    }
  });

  it('matches answers to commands by sequence, so two in flight cannot cross', async () => {
    const { link, client } = await linked();
    link.registers.set(paramByKey('cell_ovp')!.id, 3750);
    link.registers.set(paramByKey('cell_uvp')!.id, 2500);
    const [a, b] = await Promise.all([client.readParam('cell_ovp'), client.readParam('cell_uvp')]);
    expect(a).toBe(3.75);
    expect(b).toBe(2.5);
  });

  it('tags every command with the session key', async () => {
    const { link, client } = await linked();
    await client.readParam('cell_ovp');
    expect(link.commands[0]!.length).toBe(4 + 16);
  });

  it('fails a command in flight when the link drops', async () => {
    const { link, client } = await linked({ silent: () => true });
    const pending = client.readParam('cell_ovp');
    link.drop();
    await expect(pending).rejects.toThrow(LinkLostError);
  });
});
