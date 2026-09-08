import { ApiClient } from '../api/client';
import type { BatterySnapshot } from './types';
import { UploadBuffer } from './uploadBuffer';
import { UPLOAD_CHUNK, flushTelemetry } from './uploader';

jest.mock('../diagnostics/fieldLog', () => ({ logInfo: jest.fn(), logWarn: jest.fn() }));

const frame = (timestamp: number, faults: number = 0): BatterySnapshot =>
  ({
    timestamp,
    soc: 72,
    packVoltage: 79.2,
    packCurrent: -12.4,
    temperatures: [24, 26],
    cellVoltages: [],
    cellCount: 24,
    minCellV: 3.28,
    maxCellV: 3.31,
    deltaMv: 30,
    chargeMos: true,
    dischargeMos: true,
    balancing: false,
    balancingCells: [],
    faults: Array.from({ length: faults }, (_, i) => ({
      code: `F${i}`,
      label: `F${i}`,
      level: 'Critical' as const,
    })),
    cycles: 120,
    soh: 98,
    bmsModel: 'JBD SP24S004',
    bmsFirmware: '1.2.3',
    bleState: 'connected',
    location: null,
  }) as BatterySnapshot;

const ok = (body: unknown) =>
  ({ status: 200, ok: true, text: async () => JSON.stringify(body), json: async () => body }) as Response;

function clientWith(handler: (body: unknown, url: string) => Response | Promise<Response>) {
  const sent: { url: string; body: unknown }[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.test',
    getTokens: () => ({ accessToken: 'a', refreshToken: 'r' }),
    onTokens: () => undefined,
    onSignedOut: () => undefined,
    fetchImpl: (async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      sent.push({ url, body });
      return handler(body, url);
    }) as unknown as typeof fetch,
  });
  return { client, sent };
}

const echo = (body: unknown) => {
  const samples = (body as { samples: unknown[] }).samples;
  return ok({ received: samples.length, stored: samples.length, keptForStateChange: 0 });
};

/** A buffer holding `n` thinned frames, one per interval. */
const filled = (n: number, faultsAt: number[] = []) => {
  const b = new UploadBuffer();
  for (let i = 0; i < n; i += 1) {
    b.offer(frame(i * 10_000, faultsAt.includes(i) ? 1 : 0));
  }
  return b;
};

describe('sending a batch', () => {
  it('sends the buffered frames', async () => {
    const { client, sent } = clientWith(echo);
    const result = await flushTelemetry(client, 'BAT-1', filled(4));

    expect(result.sent).toBe(4);
    expect((sent[0].body as { samples: unknown[] }).samples).toHaveLength(4);
  });

  it('sends nothing when the buffer is empty', async () => {
    const { client, sent } = clientWith(echo);
    const result = await flushTelemetry(client, 'BAT-1', new UploadBuffer());

    expect(sent).toHaveLength(0);
    expect(result).toEqual({ sent: 0, stored: 0, keptForStateChange: 0 });
  });

  it('caps a request at one chunk', async () => {
    const { client, sent } = clientWith(echo);
    await flushTelemetry(client, 'BAT-1', filled(UPLOAD_CHUNK + 50));
    expect((sent[0].body as { samples: unknown[] }).samples).toHaveLength(UPLOAD_CHUNK);
  });

  it('escapes the battery id in the path', async () => {
    const { client, sent } = clientWith(echo);
    await flushTelemetry(client, 'BAT/00 42', filled(1));
    expect(sent[0].url).toBe('https://api.test/batteries/BAT%2F00%2042/telemetry');
  });

  /**
   * `stateChange` is how this app's own buffer protects an event from its own
   * thinning. The server decides state changes for itself, from fault counts.
   */
  it('does not send the client-only state-change marker', async () => {
    const { client, sent } = clientWith(echo);
    await flushTelemetry(client, 'BAT-1', filled(3, [1]));

    const samples = (sent[0].body as { samples: Record<string, unknown>[] }).samples;
    expect(samples.every((s) => !('stateChange' in s))).toBe(true);
    expect(samples[0]).toHaveProperty('faultCount');
  });

  it('reports what the server said it kept for a state change', async () => {
    const { client } = clientWith(() =>
      ok({ received: 3, stored: 3, keptForStateChange: 1 })
    );
    const result = await flushTelemetry(client, 'BAT-1', filled(3, [1]));
    expect(result.keptForStateChange).toBe(1);
  });
});

describe('retiring frames', () => {
  it('removes exactly what was sent', async () => {
    const { client } = clientWith(echo);
    const buffer = filled(4);
    await flushTelemetry(client, 'BAT-1', buffer);
    expect(buffer.size).toBe(0);
  });

  it('leaves the remainder queued when a chunk did not cover everything', async () => {
    const { client } = clientWith(echo);
    const buffer = filled(UPLOAD_CHUNK + 30);
    await flushTelemetry(client, 'BAT-1', buffer);
    expect(buffer.size).toBe(30);
  });

  /**
   * A frame that arrived after the request went out was never in it, and must
   * not be retired by a response that never saw it.
   */
  it('does not retire a frame that arrived mid-flight', async () => {
    const buffer = filled(2);
    const { client } = clientWith((body) => {
      // The link is still live: another frame lands before the reply.
      buffer.offer(frame(99 * 10_000));
      return echo(body);
    });

    await flushTelemetry(client, 'BAT-1', buffer);

    expect(buffer.size).toBe(1);
    expect(buffer.peek()[0]!.recordedAt).toBe(99 * 10_000);
  });
});

describe('when the upload fails', () => {
  it('retires nothing on a transport failure', async () => {
    const { client } = clientWith(() => {
      throw new TypeError('Network request failed');
    });
    const buffer = filled(4);
    const result = await flushTelemetry(client, 'BAT-1', buffer);

    expect(buffer.size).toBe(4);
    expect(result.sent).toBe(0);
    expect(result.error).toBeDefined();
  });

  it('retires nothing when the battery is refused', async () => {
    const { client } = clientWith(
      () =>
        ({
          status: 404,
          ok: false,
          text: async () => JSON.stringify({ error: 'not_found', message: 'Battery not found' }),
          json: async () => ({ error: 'not_found', message: 'Battery not found' }),
        }) as Response
    );
    const buffer = filled(4);
    const result = await flushTelemetry(client, 'BAT-1', buffer);

    expect(buffer.size).toBe(4);
    expect(result.error).toBe('Battery not found');
  });

  it('sends the same frames again on the next attempt', async () => {
    let attempt = 0;
    const { client, sent } = clientWith((body) => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('Network request failed');
      return echo(body);
    });

    const buffer = filled(3);
    await flushTelemetry(client, 'BAT-1', buffer);
    await flushTelemetry(client, 'BAT-1', buffer);

    const first = (sent[0].body as { samples: { recordedAt: number }[] }).samples;
    const second = (sent[1].body as { samples: { recordedAt: number }[] }).samples;
    expect(second.map((s) => s.recordedAt)).toEqual(first.map((s) => s.recordedAt));
  });
});
