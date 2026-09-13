import { BleSource } from './BleSource';
import { WriteTimeoutError, classifyWrite } from './writeOutcome';
import { GatewayClient } from '../ble/gateway';
import { FakeGatewayLink } from '../ble/fakeGateway';
import { hexToBytes } from '../ble/sha256';

/**
 * The seam every screen writes through. What matters is how each thing the
 * gateway can say comes out as a WriteResult, because the classifier turns
 * that into the ledger's outcome and the technician's message.
 */
const KEY = hexToBytes('0f'.repeat(32));

const source = async (options: Partial<ConstructorParameters<typeof FakeGatewayLink>[0]> = {}) => {
  const link = new FakeGatewayLink({ serial: 'GW-000184', key: KEY, ...options });
  const client = new GatewayClient(link, { random: (n) => new Uint8Array(n).fill(1) });
  await client.open();
  await client.authenticate(KEY);
  return { link, src: new BleSource(client) };
};

describe('BleSource', () => {
  it('is not simulated', async () => {
    const { src } = await source();
    expect(src.simulated).toBe(false);
  });

  it('reports a write by what the BMS holds', async () => {
    const { src } = await source();
    const r = await src.writeSetting('cell_ovp', 3.78);
    expect(r).toEqual({ ok: true, readBack: 3.78 });
    expect(classifyWrite(3.78, 3, r, null).outcome).toBe('success');
  });

  it('lets the classifier call a clamped write adjusted', async () => {
    const { src } = await source({ clamp: (_id, wire) => Math.min(wire, 3700) });
    const r = await src.writeSetting('cell_ovp', 3.78);
    expect(classifyWrite(3.78, 3, r, null).outcome).toBe('adjusted');
  });

  it('reports a refusal as a refusal, with the reason', async () => {
    const { src } = await source({ refuse: () => true });
    const r = await src.writeSetting('cell_ovp', 4.3);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/refused the value/);
    expect(classifyWrite(4.3, 3, r, null).outcome).toBe('rejected');
  });

  /**
   * A silent BMS is a timeout, never a refusal: the write may have landed,
   * and "refused" invites writing the same thing again.
   */
  it('reports a silent BMS as a timeout', async () => {
    jest.useFakeTimers();
    try {
      const { src } = await source({ silent: () => true });
      const pending = src.writeSetting('cell_ovp', 3.7);
      const expectation = expect(pending).rejects.toThrow(WriteTimeoutError);
      jest.advanceTimersByTime(7000);
      await expectation;
    } finally {
      jest.useRealTimers();
    }
  });

  it('reads a setting in display units', async () => {
    const { link, src } = await source();
    link.registers.set(0x01, 3750);
    expect(await src.readSetting('cell_ovp')).toBe(3.75);
  });
});
