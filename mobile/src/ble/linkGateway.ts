/**
 * PRD §7.4, for real: Connect gateway → Authenticate device → Detect BMS.
 *
 * The only place a GatewayClient is made, so the order the contract demands
 * is enforced in one function: find a peripheral, read who it says it is,
 * check that against the company's own list, prove the key both ways, and
 * only then look at the BMS. Each stage reports itself so the screen can
 * show which one failed — a failure that says "could not connect" when the
 * gateway answered and was refused sends a technician to check the wrong
 * thing.
 *
 * `USE_MOCK` (useTelemetryStore) is the other path: the same three stages
 * with the same timing, driving the simulator, so every screen is walkable
 * before a gateway exists.
 */
import { Platform } from 'react-native';
import { ADVERTISED_NAME_PREFIX, GATEWAY_SERVICE } from './codec';
import { GatewayClient } from './gateway';
import { BleUnavailableError, type GattFinder } from './link';
import { hexToBytes } from './sha256';
import { usable, type KnownGateway } from '../store/gatewayKeys';
import type { ConnectStage } from '../store/useSessionStore';

export const FIND_TIMEOUT_MS = 12_000;

export interface LinkOutcome {
  client: GatewayClient;
  serial: string;
  bmsModel: string | null;
}

export class LinkFailedError extends Error {
  constructor(
    readonly stage: ConnectStage,
    message: string
  ) {
    super(message);
    this.name = 'LinkFailedError';
  }
}

/** The finder for this platform; injectable for tests. */
export async function defaultFinder(): Promise<GattFinder> {
  if (Platform.OS === 'web') {
    const { webFinder, available } = await import('./webLink');
    const a = await available();
    if (!a.ok) throw new BleUnavailableError(a.reason ?? 'Bluetooth is not available');
    return webFinder;
  }
  const { nativeFinder } = await import('./plxLink');
  return nativeFinder;
}

const random = (n: number): Uint8Array => {
  const out = new Uint8Array(n);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => void } }).crypto;
  if (c?.getRandomValues) {
    c.getRandomValues(out);
  } else {
    // expo-crypto polyfills crypto.getRandomValues on native; if it is
    // somehow absent this is a development build, and a weak nonce here
    // weakens replay resistance, not the key. Still, say so.
    console.warn('[ble] crypto.getRandomValues is missing; nonces are weak');
    for (let i = 0; i < n; i += 1) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
};

export async function linkGateway(
  batteryId: string,
  known: KnownGateway[],
  onStage: (stage: ConnectStage) => void,
  finder?: GattFinder
): Promise<LinkOutcome> {
  const trusted = known.filter(usable);
  const bySerial = new Map(trusted.map((g) => [g.serial, g]));
  const forThisPack = trusted.filter((g) => g.assignedBatteryId === batteryId);

  if (trusted.length === 0) {
    throw new LinkFailedError(
      'connecting',
      'Your company has no gateway in service that this app holds a key for. An administrator registers gateways from Company → Gateways.'
    );
  }

  /* -------------------------------------------------- 1. connect */
  onStage('connecting');
  const find = finder ?? (await defaultFinder());
  const link = await find
    .choose({
      service: GATEWAY_SERVICE,
      namePrefix: ADVERTISED_NAME_PREFIX,
      timeoutMs: FIND_TIMEOUT_MS,
      // The advertised name carries the serial's tail; refuse what the
      // company has not registered before even connecting, when possible.
      accept: ({ name }) => {
        if (!name) return true;
        const tail = name.slice(ADVERTISED_NAME_PREFIX.length);
        const candidates = forThisPack.length ? forThisPack : trusted;
        return candidates.some((g) => g.serial.endsWith(tail));
      },
    })
    .catch((error: unknown) => {
      throw new LinkFailedError('connecting', error instanceof Error ? error.message : 'Could not find a gateway');
    });

  const client = new GatewayClient(link, { random });
  const identity = await client.open().catch((error: unknown) => {
    throw new LinkFailedError('connecting', error instanceof Error ? error.message : 'Could not connect to the gateway');
  });

  /* --------------------------------------------- 2. authenticate */
  onStage('authenticating');
  const serial = identity.serial;
  const gateway = serial ? bySerial.get(serial) : undefined;
  if (!serial || !gateway) {
    await client.close();
    throw new LinkFailedError(
      'authenticating',
      serial
        ? `Gateway ${serial} is not one of your company's gateways in service. It was not trusted.`
        : 'That gateway is not provisioned: it has no serial and no key. Set it up from Company → Gateways first.'
    );
  }
  if (forThisPack.length && !forThisPack.some((g) => g.serial === serial)) {
    // Assigned to a different pack: allowed, but named, because writing to
    // the wrong battery is exactly the mistake worth a sentence.
    console.warn(`[ble] gateway ${serial} is not the one assigned to ${batteryId}`);
  }
  try {
    await client.authenticate(hexToBytes(gateway.authKey!));
  } catch (error) {
    throw new LinkFailedError(
      'authenticating',
      error instanceof Error ? error.message : `Gateway ${serial} could not be verified`
    );
  }

  /* --------------------------------------------------- 3. detect */
  onStage('detecting');
  if (!identity.bmsModel) {
    // Verified gateway, no BMS behind it. Connected but honest about it: the
    // telemetry will say the BMS is unreachable on every frame.
    console.warn(`[ble] gateway ${serial} reports no BMS on its UART`);
  }

  return { client, serial, bmsModel: identity.bmsModel };
}
