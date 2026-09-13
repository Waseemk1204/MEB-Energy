import { LinkFailedError, linkGateway } from './linkGateway';
import { FakeGatewayLink } from './fakeGateway';
import { BleUnavailableError, type GattFinder, type GattLink } from './link';
import { bytesToHex, hexToBytes } from './sha256';
import type { KnownGateway } from '../store/gatewayKeys';
import type { ConnectStage } from '../store/useSessionStore';

/**
 * PRD §7.4 as the app really runs it. The finder is a fake handing over
 * software gateways; everything after that is the real client and the real
 * handshake. What is asserted is the order, and where each refusal lands.
 */

const KEY = hexToBytes('0f'.repeat(32));
const known = (over: Partial<KnownGateway> = {}): KnownGateway => ({
  id: 'g1',
  serial: 'GW-000184',
  authKey: bytesToHex(KEY),
  assignedBatteryId: 'b1',
  securityStatus: 'valid',
  ...over,
});

const finderFor = (links: GattLink[]): GattFinder & { asked: { name: string | null }[] } => {
  const asked: { name: string | null }[] = [];
  return {
    asked,
    async choose({ accept }) {
      for (const l of links) {
        asked.push({ name: l.name });
        if (accept({ id: l.id, name: l.name })) return l;
      }
      throw new BleUnavailableError('No gateway found nearby.');
    },
  };
};

const stagesOf = async (run: (onStage: (s: ConnectStage) => void) => Promise<unknown>) => {
  const stages: ConnectStage[] = [];
  try {
    await run((s) => stages.push(s));
  } catch (error) {
    return { stages, error };
  }
  return { stages, error: null };
};

describe('linking a gateway', () => {
  it('connects, verifies, detects — in that order — and hands back a live client', async () => {
    const link = new FakeGatewayLink({ serial: 'GW-000184', key: KEY });
    const { stages, error } = await stagesOf(async (onStage) => {
      const outcome = await linkGateway('b1', [known()], onStage, finderFor([link]));
      expect(outcome.serial).toBe('GW-000184');
      expect(outcome.bmsModel).toBe('JBD SP24S004');
      expect(outcome.client.authenticated).toBe(true);
      await outcome.client.close();
    });
    expect(error).toBeNull();
    expect(stages).toEqual(['connecting', 'authenticating', 'detecting']);
  });

  it('refuses to start when the company has no usable gateway', async () => {
    const { stages, error } = await stagesOf((onStage) =>
      linkGateway('b1', [known({ securityStatus: 'revoked' })], onStage, finderFor([]))
    );
    expect(stages).toEqual([]);
    expect(error).toBeInstanceOf(LinkFailedError);
    expect((error as LinkFailedError).stage).toBe('connecting');
    expect((error as Error).message).toMatch(/no gateway in service/);
  });

  it('treats a gateway with no key as unusable', async () => {
    const { error } = await stagesOf((onStage) =>
      linkGateway('b1', [known({ authKey: null })], onStage, finderFor([]))
    );
    expect((error as Error).message).toMatch(/no gateway in service/);
  });

  /** The advertised name is enough to skip a stranger before connecting. */
  it('does not even connect to a name the company has not registered', async () => {
    const stranger = new FakeGatewayLink({ serial: 'GW-999999', key: KEY });
    const ours = new FakeGatewayLink({ serial: 'GW-000184', key: KEY });
    const finder = finderFor([stranger, ours]);
    const { stages, error } = await stagesOf(async (onStage) => {
      const o = await linkGateway('b1', [known()], onStage, finder);
      await o.client.close();
    });
    expect(error).toBeNull();
    expect(finder.asked.map((a) => a.name)).toEqual(['MEB-999999', 'MEB-000184']);
    expect(stages[0]).toBe('connecting');
  });

  it('fails at "connecting" when nothing is found', async () => {
    const { stages, error } = await stagesOf((onStage) =>
      linkGateway('b1', [known()], onStage, finderFor([]))
    );
    expect(stages).toEqual(['connecting']);
    expect((error as LinkFailedError).stage).toBe('connecting');
    expect((error as Error).message).toMatch(/No gateway found/);
  });

  /** The property the handshake exists for, seen from the top. */
  it('fails at "authenticating" for a gateway with the wrong key, and closes the link', async () => {
    const impostor = new FakeGatewayLink({ serial: 'GW-000184', key: hexToBytes('ee'.repeat(32)) });
    const { stages, error } = await stagesOf((onStage) =>
      linkGateway('b1', [known()], onStage, finderFor([impostor]))
    );
    expect(stages).toEqual(['connecting', 'authenticating']);
    expect((error as LinkFailedError).stage).toBe('authenticating');
    expect((error as Error).message).toMatch(/could not be verified/);
    expect(impostor.commands).toHaveLength(0);
  });

  it('fails at "authenticating" for a serial the company does not hold, even with a valid name', async () => {
    // Advertises a registered tail but its identity says otherwise.
    const link = new FakeGatewayLink({ serial: 'GW-000184', key: KEY });
    Object.defineProperty(link, 'read', {
      value: async () => new Uint8Array([0x01, 1, 1, 0x02, 9, ...Buffer.from('GW-000185'), 0x08, 1, 1]),
    });
    const { stages, error } = await stagesOf((onStage) =>
      linkGateway('b1', [known()], onStage, finderFor([link]))
    );
    expect(stages).toEqual(['connecting', 'authenticating']);
    expect((error as Error).message).toMatch(/GW-000185 is not one of your company/);
  });

  it('names an unprovisioned gateway as such', async () => {
    const bare = new FakeGatewayLink({ serial: 'GW-000184', key: null });
    const { error } = await stagesOf((onStage) => linkGateway('b1', [known()], onStage, finderFor([bare])));
    expect((error as Error).message).toMatch(/not provisioned/);
  });

  it('prefers the gateway assigned to the pack when several are registered', async () => {
    const other = new FakeGatewayLink({ serial: 'GW-000185', key: KEY });
    const mine = new FakeGatewayLink({ serial: 'GW-000184', key: KEY });
    const finder = finderFor([other, mine]);
    const list = [known(), known({ id: 'g2', serial: 'GW-000185', assignedBatteryId: 'b2' })];
    const { error } = await stagesOf(async (onStage) => {
      const o = await linkGateway('b1', list, onStage, finder);
      expect(o.serial).toBe('GW-000184');
      await o.client.close();
    });
    expect(error).toBeNull();
  });
});
