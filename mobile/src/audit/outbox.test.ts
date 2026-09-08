import { ApiClient } from '../api/client';
import type { ActivityEntry } from '../store/useActivityStore';
import { UPLOAD_BATCH, eventIdFor, flushOnce, pending } from './outbox';

jest.mock('../diagnostics/fieldLog', () => ({ logInfo: jest.fn(), logWarn: jest.fn() }));

const entry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: 'w1700000000001',
  timestamp: 1_700_000_000_001,
  parameterKey: 'cell_ovp',
  displayName: 'Cell over-voltage',
  oldValue: '3.750 V',
  newValue: '3.800 V',
  actor: 'You',
  source: 'local',
  dangerLevel: 'Critical',
  result: 'success',
  ...over,
});

/** A client whose single request is driven by `handler`. */
function clientWith(handler: (body: unknown) => Response | Promise<Response>) {
  const sent: unknown[] = [];
  const client = new ApiClient({
    baseUrl: 'https://api.test',
    getTokens: () => ({ accessToken: 'a', refreshToken: 'r' }),
    onTokens: () => undefined,
    onSignedOut: () => undefined,
    fetchImpl: (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      sent.push(body);
      return handler(body);
    }) as unknown as typeof fetch,
  });
  return { client, sent };
}

const ok = (body: unknown) =>
  ({ status: 200, ok: true, text: async () => JSON.stringify(body), json: async () => body }) as Response;

/** Acknowledge everything the app sent, as the real server does. */
const echo = (body: unknown) => {
  const events = (body as { events: { clientEventId: string }[] }).events;
  return ok({
    accepted: events.map((e) => ({
      clientEventId: e.clientEventId,
      auditId: `srv-${e.clientEventId}`,
      duplicate: false,
    })),
    stored: events.length,
    duplicates: 0,
  });
};

describe('choosing what to send', () => {
  it('sends only entries the server has not accepted', () => {
    const queue = pending([
      entry({ id: 'a', synced: true }),
      entry({ id: 'b', synced: false }),
      entry({ id: 'c' }),
    ]);
    expect(queue.map((e) => e.id)).toEqual(['b', 'c']);
  });

  /** An entry with no flag has never been sent; assuming otherwise loses it. */
  it('treats a missing flag as unsent', () => {
    expect(pending([entry({ id: 'x' })])).toHaveLength(1);
  });

  it('sends oldest first, so history arrives in order', () => {
    const queue = pending([
      entry({ id: 'new', timestamp: 3000 }),
      entry({ id: 'old', timestamp: 1000 }),
      entry({ id: 'mid', timestamp: 2000 }),
    ]);
    expect(queue.map((e) => e.id)).toEqual(['old', 'mid', 'new']);
  });

  it('caps a batch so one failure is small', async () => {
    const many = Array.from({ length: UPLOAD_BATCH + 20 }, (_, i) =>
      entry({ id: `w17000000000${i}`, timestamp: 1000 + i })
    );
    const { client, sent } = clientWith(echo);
    await flushOnce(client, 'BAT-1', many);
    expect((sent[0] as { events: unknown[] }).events).toHaveLength(UPLOAD_BATCH);
  });

  it('sends nothing when everything is already accepted', async () => {
    const { client, sent } = clientWith(echo);
    const result = await flushOnce(client, 'BAT-1', [entry({ synced: true })]);
    expect(sent).toHaveLength(0);
    expect(result).toEqual({ confirmed: [], stored: 0, duplicates: 0 });
  });

  it('pads a short id to what the server will accept', () => {
    expect(eventIdFor(entry({ id: 'w1' })).length).toBeGreaterThanOrEqual(8);
    expect(eventIdFor(entry({ id: 'w1700000000001' }))).toBe('w1700000000001');
  });
});

describe('what the server is told', () => {
  it('sends when the write happened, not when it was uploaded', async () => {
    const { client, sent } = clientWith(echo);
    await flushOnce(client, 'BAT-1', [entry({ timestamp: 1_699_000_000_000 })]);
    const event = (sent[0] as { events: { occurredAt: number }[] }).events[0];
    expect(event.occurredAt).toBe(1_699_000_000_000);
  });

  it('sends refusals and timeouts, not only successes', async () => {
    const { client, sent } = clientWith(echo);
    await flushOnce(client, 'BAT-1', [
      entry({ id: 'w17000000001', result: 'rejected', timestamp: 1 }),
      entry({ id: 'w17000000002', result: 'timeout', timestamp: 2 }),
      entry({ id: 'w17000000003', result: 'indeterminate', timestamp: 3 }),
    ]);
    const events = (sent[0] as { events: { result: string }[] }).events;
    expect(events.map((e) => e.result)).toEqual(['rejected', 'timeout', 'indeterminate']);
  });

  it('escapes the battery id in the path', async () => {
    let url = '';
    const client = new ApiClient({
      baseUrl: 'https://api.test',
      getTokens: () => ({ accessToken: 'a', refreshToken: 'r' }),
      onTokens: () => undefined,
      onSignedOut: () => undefined,
      fetchImpl: (async (u: string) => {
        url = u;
        return ok({ accepted: [], stored: 0, duplicates: 0 });
      }) as unknown as typeof fetch,
    });
    await flushOnce(client, 'BAT/00 42', [entry()]);
    expect(url).toBe('https://api.test/batteries/BAT%2F00%2042/audit');
  });
});

describe('retiring entries', () => {
  it('confirms exactly what the server acknowledged', async () => {
    const { client } = clientWith(echo);
    const result = await flushOnce(client, 'BAT-1', [
      entry({ id: 'w17000000001', timestamp: 1 }),
      entry({ id: 'w17000000002', timestamp: 2 }),
    ]);
    expect(result.confirmed).toEqual(['w17000000001', 'w17000000002']);
  });

  /**
   * The rule that matters. A 200 is not proof the server stored everything in
   * the batch — only the ids it names are safe to retire.
   */
  it('does not retire an entry the server left out of its response', async () => {
    const { client } = clientWith((body) => {
      const events = (body as { events: { clientEventId: string }[] }).events;
      return ok({
        accepted: [
          { clientEventId: events[0].clientEventId, auditId: 'srv-1', duplicate: false },
        ],
        stored: 1,
        duplicates: 0,
      });
    });

    const result = await flushOnce(client, 'BAT-1', [
      entry({ id: 'w17000000001', timestamp: 1 }),
      entry({ id: 'w17000000002', timestamp: 2 }),
    ]);
    expect(result.confirmed).toEqual(['w17000000001']);
  });

  it('retires an entry the server says it already had', async () => {
    const { client } = clientWith((body) => {
      const events = (body as { events: { clientEventId: string }[] }).events;
      return ok({
        accepted: events.map((e) => ({
          clientEventId: e.clientEventId,
          auditId: 'srv-existing',
          duplicate: true,
        })),
        stored: 0,
        duplicates: events.length,
      });
    });

    const result = await flushOnce(client, 'BAT-1', [entry({ id: 'w17000000001' })]);
    expect(result.confirmed).toEqual(['w17000000001']);
    expect(result.duplicates).toBe(1);
  });
});

describe('when the upload fails', () => {
  it('retires nothing, because the entries are the only copy', async () => {
    const { client } = clientWith(() => {
      throw new TypeError('Network request failed');
    });
    const result = await flushOnce(client, 'BAT-1', [entry(), entry({ id: 'w17000000002' })]);
    expect(result.confirmed).toEqual([]);
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
    const result = await flushOnce(client, 'BAT-1', [entry()]);
    expect(result.confirmed).toEqual([]);
    expect(result.error).toBe('Battery not found');
  });

  /** A retry after a failure resends the same ids, which the server dedupes. */
  it('resends the same ids on a retry', async () => {
    let attempt = 0;
    const { client, sent } = clientWith((body) => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('Network request failed');
      return echo(body);
    });

    const entries = [entry({ id: 'w17000000001' })];
    await flushOnce(client, 'BAT-1', entries);
    await flushOnce(client, 'BAT-1', entries);

    const first = (sent[0] as { events: { clientEventId: string }[] }).events[0].clientEventId;
    const second = (sent[1] as { events: { clientEventId: string }[] }).events[0].clientEventId;
    expect(second).toBe(first);
  });
});
