import React from 'react';
import { render, screen } from '@testing-library/react-native';

const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: mockBack, canGoBack: () => true }),
}));
jest.mock('../src/api/session', () => ({ api: {}, onSessionExpired: jest.fn(), setTokens: jest.fn() }));

import Device from '../app/device';
import SupportSession from '../app/support-session';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { useSessionStore } from '../src/store/useSessionStore';
import { useTelemetryStore } from '../src/store/useTelemetryStore';
import * as supportSessions from '../src/api/supportSessions';
import { activeFor, formatStarted, listSupportSessions } from '../src/api/supportSessions';
import { ApiClient } from '../src/api/client';
import { describeSupport, useSupportStore } from '../src/store/useSupportStore';

/**
 * Two screens that presented invented values as fact.
 *
 * `Device` showed a gateway serial, hardware revision and firmware the app had
 * no way of knowing. `Support` showed an open session — an id, an
 * administrator's name, "started 4 min ago" and a pulsing *Live* indicator —
 * that corresponded to nothing at all. Somebody reading either would have
 * believed it, and neither is the sort of thing a technician double-checks.
 */

const wrap = (node: React.ReactNode) => render(<ThemeProvider>{node}</ThemeProvider>);

const session = (over: Partial<supportSessions.SupportSession> = {}) => ({
  id: 'sess-abcdef123456',
  batteryId: 'BAT-1',
  adminUserId: 'u-admin',
  startedAt: Date.now() - 4 * 60_000,
  endedAt: null,
  outcome: null,
  ...over,
});

beforeEach(() => {
  jest.restoreAllMocks();
  useSessionStore.setState({ connectedBatteryId: 'BAT-1', company: 'Real Company Ltd' });
  useTelemetryStore.setState({ snapshot: null });
  // Shared between the Dashboard row and the Support screen, so it must not
  // carry an answer from one test into the next.
  useSupportStore.getState().reset();
});

describe('the device screen', () => {
  it('invents no gateway identity', async () => {
    await wrap(<Device />);
    for (const invented of ['KYE-000184', 'HW 1.0', 'FW 1.2.4']) {
      expect(screen.queryByText(invented)).toBeNull();
    }
  });

  it('says the identity is not known rather than leaving it blank', async () => {
    await wrap(<Device />);
    expect(screen.getAllByText('Not reported yet').length).toBeGreaterThanOrEqual(3);
  });

  it('explains why it does not know', async () => {
    await wrap(<Device />);
    expect(screen.getByText(/reports its own identity over Bluetooth/)).toBeTruthy();
  });

  it('shows the battery it is actually linked to', async () => {
    await wrap(<Device />);
    expect(screen.getByText('BAT-1')).toBeTruthy();
  });

  it('says so when nothing is linked', async () => {
    useSessionStore.setState({ connectedBatteryId: null });
    await wrap(<Device />);
    expect(screen.getByText('Not connected')).toBeTruthy();
  });

  /** "just now" was hardcoded; a stale link would still have claimed it. */
  it('does not claim a recent sighting with no telemetry', async () => {
    await wrap(<Device />);
    expect(screen.queryByText('just now')).toBeNull();
  });
});

describe('picking the live session', () => {
  it('finds an open one for this battery', () => {
    expect(activeFor([session()], 'BAT-1')?.id).toBe('sess-abcdef123456');
  });

  it('ignores a closed one', () => {
    expect(activeFor([session({ endedAt: Date.now() })], 'BAT-1')).toBeNull();
  });

  it('ignores one for another battery', () => {
    expect(activeFor([session({ batteryId: 'BAT-2' })], 'BAT-1')).toBeNull();
  });

  it('takes the newest when two are somehow open', () => {
    const older = session({ id: 'old', startedAt: 1000 });
    const newer = session({ id: 'new', startedAt: 2000 });
    expect(activeFor([older, newer], 'BAT-1')?.id).toBe('new');
  });

  it('finds nothing in an empty list', () => {
    expect(activeFor([], 'BAT-1')).toBeNull();
  });
});

describe('the support screen', () => {
  it('says no session is open when none is', async () => {
    jest.spyOn(supportSessions, 'listSupportSessions').mockResolvedValue([]);
    await wrap(<SupportSession />);
    expect(await screen.findByText(/No administrator has an open session/)).toBeTruthy();
  });

  it('shows no Live indicator when nothing is live', async () => {
    jest.spyOn(supportSessions, 'listSupportSessions').mockResolvedValue([]);
    await wrap(<SupportSession />);
    await screen.findByText(/No administrator has an open session/);
    expect(screen.queryByText('Live')).toBeNull();
  });

  it('invents no session id or administrator', async () => {
    jest.spyOn(supportSessions, 'listSupportSessions').mockResolvedValue([]);
    await wrap(<SupportSession />);
    await screen.findByText(/No administrator has an open session/);
    for (const invented of ['SS-4471', 'R. Mehta', 'Aurora Fleet']) {
      expect(screen.queryByText(invented)).toBeNull();
    }
  });

  it('shows a real session when there is one', async () => {
    jest.spyOn(supportSessions, 'listSupportSessions').mockResolvedValue([session()]);
    await wrap(<SupportSession />);

    expect(await screen.findByText('sess-abc')).toBeTruthy();
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByText('Real Company Ltd')).toBeTruthy();
  });

  /**
   * "Could not check" and "there is no session" are different statements, and
   * saying the second on a failed request is the same lie in a quieter voice.
   */
  it('distinguishes not knowing from knowing there is none', async () => {
    jest.spyOn(supportSessions, 'listSupportSessions').mockResolvedValue(null);
    await wrap(<SupportSession />);

    expect(await screen.findByText(/does not mean there is none/)).toBeTruthy();
    expect(screen.queryByText(/No administrator has an open session/)).toBeNull();
  });

  it('asks nothing when no battery is linked', async () => {
    useSessionStore.setState({ connectedBatteryId: null });
    const list = jest.spyOn(supportSessions, 'listSupportSessions').mockResolvedValue([]);

    await wrap(<SupportSession />);
    expect(await screen.findByText(/Connect to a battery/)).toBeTruthy();
    expect(list).not.toHaveBeenCalled();
  });
});

describe('how long ago a session started', () => {
  const now = 1_700_000_000_000;

  it('reads relatively while that means something', () => {
    expect(formatStarted(now - 30_000, now)).toBe('just now');
    expect(formatStarted(now - 4 * 60_000, now)).toBe('4 min ago');
    expect(formatStarted(now - 3 * 3_600_000, now)).toBe('3h ago');
  });

  it('falls back to a date once it does not', () => {
    expect(formatStarted(now - 5 * 24 * 3_600_000, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

/**
 * The module's own decision, not the screen's handling of it.
 *
 * The screen test above mocks `listSupportSessions`, so it proves the screen
 * does the right thing with `null` — and proves nothing about whether `null`
 * is ever returned. Changing the module to return `[]` on failure, which would
 * make a network error read as "no session is open", passed that test
 * untouched. This is the test that fails.
 */
describe('reading support sessions', () => {
  const client = (impl: () => Response | Promise<Response>) =>
    new ApiClient({
      baseUrl: 'https://api.test',
      getTokens: () => ({ accessToken: 'a', refreshToken: 'r' }),
      onTokens: () => undefined,
      onSignedOut: () => undefined,
      fetchImpl: (async () => impl()) as unknown as typeof fetch,
    });

  const reply = (status: number, body: unknown) =>
    ({
      status,
      ok: status < 300,
      text: async () => JSON.stringify(body),
      json: async () => body,
    }) as Response;

  it('returns the sessions on success', async () => {
    const sessions = await listSupportSessions(
      client(() =>
        reply(200, {
          sessions: [
            {
              id: 's1',
              battery_id: 'BAT-1',
              admin_user_id: 'u1',
              started_at: 1000,
              ended_at: null,
              outcome: null,
            },
          ],
        })
      )
    );
    expect(sessions).toHaveLength(1);
    expect(sessions![0]!.batteryId).toBe('BAT-1');
  });

  it('returns an empty list when there genuinely are none', async () => {
    expect(await listSupportSessions(client(() => reply(200, { sessions: [] })))).toEqual([]);
  });

  /** null, not []. The two mean different things and the screen says so. */
  it('returns null when it could not ask', async () => {
    expect(
      await listSupportSessions(
        client(() => {
          throw new TypeError('Network request failed');
        })
      )
    ).toBeNull();
  });

  it('returns null on a server error too', async () => {
    expect(
      await listSupportSessions(client(() => reply(500, { error: 'e', message: 'm' })))
    ).toBeNull();
  });
});


/**
 * The Dashboard is the screen a technician looks at most, and it carried three
 * literals: an invented gateway serial, a hardcoded write count, and
 * `SS-4471 active` asserting a live support session.
 */
describe('the dashboard rows', () => {
  it('describes each support state distinctly', () => {
    const said = [
      describeSupport({ kind: 'active', session: session() }),
      describeSupport({ kind: 'none' }),
      describeSupport({ kind: 'unreachable' }),
      describeSupport({ kind: 'unchecked' }),
    ];
    expect(new Set(said).size).toBe(4);
  });

  it('never says a session is open unless one is', () => {
    for (const state of [
      { kind: 'none' as const },
      { kind: 'unreachable' as const },
      { kind: 'unchecked' as const },
    ]) {
      expect(describeSupport(state)).not.toMatch(/open/i);
    }
    expect(describeSupport({ kind: 'active', session: session() })).toMatch(/open/i);
  });

  /** A failed check must not read as an all-clear. */
  it('does not let "could not check" read as "none"', () => {
    expect(describeSupport({ kind: 'unreachable' })).not.toBe(describeSupport({ kind: 'none' }));
  });
});

describe('the shared support state', () => {
  it('reports an open session for the linked pack', async () => {
    jest.spyOn(supportSessions, 'listSupportSessions').mockResolvedValue([session()]);
    await useSupportStore.getState().refresh('BAT-1');
    expect(useSupportStore.getState().state.kind).toBe('active');
  });

  it('reports none when there is none', async () => {
    jest.spyOn(supportSessions, 'listSupportSessions').mockResolvedValue([]);
    await useSupportStore.getState().refresh('BAT-1');
    expect(useSupportStore.getState().state.kind).toBe('none');
  });

  it('reports that it could not check, distinctly', async () => {
    jest.spyOn(supportSessions, 'listSupportSessions').mockResolvedValue(null);
    await useSupportStore.getState().refresh('BAT-1');
    expect(useSupportStore.getState().state.kind).toBe('unreachable');
  });

  it('asks nothing with no pack linked, and says none', async () => {
    const list = jest.spyOn(supportSessions, 'listSupportSessions');
    await useSupportStore.getState().refresh(null);

    expect(list).not.toHaveBeenCalled();
    expect(useSupportStore.getState().state.kind).toBe('none');
  });

  it('does not run two checks at once', async () => {
    const list = jest
      .spyOn(supportSessions, 'listSupportSessions')
      .mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return [];
      });

    await Promise.all([
      useSupportStore.getState().refresh('BAT-1'),
      useSupportStore.getState().refresh('BAT-1'),
    ]);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('forgets a previous answer when reset', async () => {
    jest.spyOn(supportSessions, 'listSupportSessions').mockResolvedValue([session()]);
    await useSupportStore.getState().refresh('BAT-1');

    useSupportStore.getState().reset();
    expect(useSupportStore.getState().state.kind).toBe('unchecked');
  });
});
