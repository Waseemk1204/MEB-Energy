/**
 * Drive the app's own modules against a running backend.
 *
 * Not a test — a check that the seams between this app and the API actually
 * connect, using the real client code rather than something written for the
 * occasion.
 *
 * It exists because three bugs in this project survived thorough testing and
 * repeated live verification for the same reason: the live runs used `curl` or
 * an injected stand-in in place of the real client, and **the stand-in did the
 * one thing the real client did not**. A double that behaves better than the
 * thing it replaces hides exactly the bug it was meant to find.
 *
 * So every call below goes through the module the app actually ships.
 *
 *   npm run live-check          # against http://localhost:3000
 *   API=http://host:3000 npm run live-check
 */

import { ApiClient } from '../src/api/client';
import { login } from '../src/api/auth';
import { fetchDefinitions, reconcile, describeDrift } from '../src/api/parameters';
import { profile } from '../src/bms/capabilityProfile';
import { flushOnce } from '../src/audit/outbox';
import { UploadBuffer } from '../src/telemetry/uploadBuffer';
import { flushTelemetry } from '../src/telemetry/uploader';
import { announcePresence, endPresence } from '../src/api/presence';
import { claimCommands, reportResult } from '../src/api/commands';
import type { ActivityEntry } from '../src/store/useActivityStore';
import type { BatterySnapshot } from '../src/telemetry/types';

const API = process.env.API ?? 'http://localhost:3000';

const results: { name: string; ok: boolean; detail: string }[] = [];

const check = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(46)} ${detail}`);
};

/** Plain fetch, for the setup an administrator would do in the console. */
async function admin(method: string, path: string, token: string | null, body?: unknown) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

function clientFor(tokens: { accessToken: string; refreshToken: string }) {
  let current = tokens;
  return new ApiClient({
    baseUrl: API,
    getTokens: () => current,
    onTokens: (next) => {
      current = next;
    },
    onSignedOut: () => {
      console.log('  ! the client signed itself out');
    },
  });
}

async function main() {
  console.log(`\nknowyourEV live check against ${API}\n`);

  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`Cannot reach ${API}. Start the backend first.\n`);
    process.exit(1);
  }

  const adminEmail = process.env.ADMIN_EMAIL ?? 'ops@knowyourev.example';
  const adminPassword = process.env.ADMIN_PASSWORD ?? 'first-admin-passphrase';

  const signIn = await admin('POST', '/auth/login', null, {
    email: adminEmail,
    password: adminPassword,
  });
  if (signIn.status !== 200) {
    console.error(
      `Could not sign in as ${adminEmail}. Bootstrap an administrator first, ` +
        `or set ADMIN_EMAIL and ADMIN_PASSWORD.\n`
    );
    process.exit(1);
  }
  const adminToken = signIn.body.accessToken as string;

  // A tenant of its own, so a repeated run does not collide with a real one.
  const stamp = Date.now().toString(36);
  const company = await admin('POST', '/companies', adminToken, {
    name: `Live check ${stamp}`,
    seatLimit: 5,
    batteryLimit: 5,
  });
  const companyId = company.body.companyId as string;

  const techEmail = `live-${stamp}@check.example`;
  const techPassword = 'a-live-check-passphrase';
  await admin('POST', '/users', adminToken, {
    companyId,
    email: techEmail,
    displayName: 'Live Check',
    role: 'user',
    password: techPassword,
  });

  // A company-owner account as well as the technician: the concurrent-device
  // cap applies to the owner login, which is the one likely to be shared.
  const ownerEmail = `owner-${stamp}@check.example`;
  const ownerPassword = 'a-live-check-owner-passphrase';
  await admin('POST', '/users', adminToken, {
    companyId,
    email: ownerEmail,
    displayName: 'Live Check Owner',
    role: 'company',
    password: ownerPassword,
  });

  const battery = await admin('POST', '/batteries', adminToken, {
    companyId,
    serial: `LIVE-${stamp}`,
    chemistry: 'LiFePO4',
    cellCount: 24,
    bmsModel: profile.bmsModel,
  });
  const batteryId = battery.body.batteryId as string;

  /* ------------------------------------------------------------- sign in */

  console.log('Signing in — src/api/auth.ts');
  const bootstrapClient = new ApiClient({
    baseUrl: API,
    getTokens: () => null,
    onTokens: () => undefined,
    onSignedOut: () => undefined,
  });

  const session = await login(bootstrapClient, techEmail, techPassword);
  check('login returns a usable session', !!session.accessToken, session.user.email);
  check(
    'login names the tenant',
    session.company?.name === `Live check ${stamp}`,
    session.company?.name ?? 'none'
  );

  /*
   * The concurrent-device cap, through the real client rather than curl. The
   * owner account is limited to two signed-in devices; a third signs out the
   * one used longest ago, and says which.
   *
   * A technician is deliberately not capped — they hold their own seat — so
   * both halves are checked here. Getting this backwards would sign a field
   * user out of their tablet every time they picked up their phone.
   */
  console.log('\nDevice cap — src/api/auth.ts');
  const ownerSignIn = (label: string) =>
    login(
      new ApiClient({
        baseUrl: API,
        getTokens: () => null,
        onTokens: () => undefined,
        onSignedOut: () => undefined,
        // Through the existing fetch seam rather than a headers option on the
        // client: a real phone sends its own User-Agent, and widening the
        // production client's surface for a check would be the wrong trade.
        fetchImpl: ((url: string, init: RequestInit = {}) =>
          fetch(url, {
            ...init,
            headers: { ...(init.headers as Record<string, string>), 'user-agent': label },
          })) as unknown as typeof fetch,
      }),
      ownerEmail,
      ownerPassword
    );

  const onPhone = await ownerSignIn('Mozilla/5.0 (iPhone) Safari/604.1');
  check('the owner signs in on a first device', (onPhone.signedOut ?? []).length === 0,
    `signed out ${(onPhone.signedOut ?? []).length}`);

  const onMac = await ownerSignIn('Mozilla/5.0 (Macintosh) Chrome/120 Safari/537');
  check('a second device is allowed', (onMac.signedOut ?? []).length === 0,
    `signed out ${(onMac.signedOut ?? []).length}`);

  const onWindows = await ownerSignIn('Mozilla/5.0 (Windows NT 10.0) Firefox/121.0');
  check('a third signs out the least recently used', (onWindows.signedOut ?? []).length === 1,
    onWindows.signedOut?.[0] ?? 'nothing');
  check('and says which device it was',
    (onWindows.signedOut?.[0] ?? '').includes('iPhone'), onWindows.signedOut?.[0] ?? 'nothing');

  const techAgain = await login(
    new ApiClient({
      baseUrl: API,
      getTokens: () => null,
      onTokens: () => undefined,
      onSignedOut: () => undefined,
    }),
    techEmail,
    techPassword
  );
  check('a field user is not capped', (techAgain.signedOut ?? []).length === 0,
    `signed out ${(techAgain.signedOut ?? []).length}`);

  const api = clientFor({
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
  });

  /* -------------------------------------------------- capability profile */

  console.log('\nCapability profile — src/api/parameters.ts');
  const definitions = await fetchDefinitions(api, profile.bmsModel);
  check('the server defines this BMS', definitions.length > 0, `${definitions.length} parameters`);

  const { parameters, drift } = reconcile(profile, definitions);
  check(
    'the bundled profile agrees with the server',
    drift.length === 0,
    drift.length === 0 ? 'no drift' : describeDrift(drift).slice(0, 2).join('; ')
  );
  check('every bundled parameter survives', parameters.length === profile.parameters.length,
    `${parameters.length} of ${profile.parameters.length}`);

  /* ------------------------------------------------------------ presence */

  console.log('\nPresence — src/api/presence.ts');
  const before = await admin('GET', `/batteries/${batteryId}/session`, adminToken);
  check('nobody is on site to begin with', before.body.active === false, 'active: false');

  const presence = await announcePresence(api, batteryId);
  check('announcing presence opens a session', presence !== null, presence?.sessionId.slice(0, 8) ?? 'failed');

  const during = await admin('GET', `/batteries/${batteryId}/session`, adminToken);
  check('the console can see the technician', during.body.active === true, 'active: true');

  /* ------------------------------------------------------------ telemetry */

  console.log('\nTelemetry — src/telemetry/uploadBuffer.ts, uploader.ts');
  const buffer = new UploadBuffer();
  const t0 = Date.now() - 10 * 60 * 1000;

  // Two hundred frames at 2 Hz, with a fault that appears and clears inside
  // one ten-second window — the case the thinning must not erase.
  //
  // Deliberately off the interval boundary. Frame 40 would land exactly on a
  // ten-second mark and be kept by the schedule anyway, which tests nothing:
  // the rule that matters is the one that keeps a transition the schedule
  // would have thrown away.
  for (let i = 0; i < 200; i += 1) {
    const at = t0 + i * 500;
    const faulted = i >= 43 && i < 51;
    buffer.offer({
      timestamp: at,
      soc: 80 - i * 0.05,
      packVoltage: 79.2,
      packCurrent: -12,
      temperatures: [24, faulted ? 68 : 26],
      cellVoltages: [],
      cellCount: 24,
      minCellV: 3.28,
      maxCellV: 3.31,
      deltaMv: 30,
      chargeMos: true,
      dischargeMos: true,
      balancing: false,
      balancingCells: [],
      faults: faulted ? [{ code: 'OT', label: 'Over-temperature', level: 'Critical' }] : [],
      cycles: 120,
      soh: 98,
      bmsModel: profile.bmsModel,
      bmsFirmware: '1.2.3',
      bleState: 'connected',
      location: null,
    } as BatterySnapshot);
  }

  const thinned = buffer.size;
  const flushed = await flushTelemetry(api, batteryId, buffer);
  check('thinning cuts 2 Hz down to something uploadable', thinned < 40, `200 frames -> ${thinned}`);
  check('the server accepted them', flushed.stored > 0, `stored ${flushed.stored}`);
  check('the buffer retired exactly what was sent', buffer.size === 0, `${buffer.size} left`);

  // The property that matters is not a counter — it is that the episode is
  // findable in the stored history at all. A thinning that dropped it would
  // leave a record reading as calm on both sides of an over-temperature.
  const stored = await admin('GET', `/batteries/${batteryId}/telemetry?limit=500`, adminToken);
  const readings = (stored.body.readings as { recorded_at: number; fault_count: number }[]).sort(
    (a, b) => a.recorded_at - b.recorded_at
  );
  const raised = readings.findIndex((r) => r.fault_count > 0);
  const cleared = readings.findIndex((r, i) => i > raised && raised !== -1 && r.fault_count === 0);

  check('the fault is findable in the stored history', raised !== -1, `at index ${raised}`);
  check('so is the moment it cleared', cleared !== -1, `at index ${cleared}`);
  check(
    'the episode is not smeared across the whole series',
    raised !== -1 && cleared !== -1 && cleared - raised <= 3,
    raised !== -1 && cleared !== -1 ? `${cleared - raised} readings wide` : 'not found'
  );

  /* ---------------------------------------------------------- audit outbox */

  console.log('\nAudit outbox — src/audit/outbox.ts');
  const entries: ActivityEntry[] = [
    {
      id: `w${Date.now()}1`,
      timestamp: Date.now() - 2000,
      parameterKey: 'cell_ovp',
      displayName: 'Cell over-voltage',
      oldValue: '3.750 V',
      newValue: '3.780 V',
      actor: 'You',
      source: 'local',
      dangerLevel: 'Critical',
      result: 'success',
    },
    {
      id: `w${Date.now()}2`,
      timestamp: Date.now() - 1000,
      parameterKey: 'cell_uvp',
      displayName: 'Cell under-voltage',
      oldValue: '2.500 V',
      newValue: '2.450 V',
      actor: 'You',
      source: 'local',
      dangerLevel: 'Critical',
      result: 'indeterminate',
    },
  ];

  const first = await flushOnce(api, batteryId, entries);
  check('on-site writes reach the ledger', first.stored === 2, `stored ${first.stored}`);

  const repeat = await flushOnce(api, batteryId, entries);
  check(
    're-uploading the same writes stores nothing new',
    repeat.stored === 0 && repeat.duplicates === 2,
    `stored ${repeat.stored}, duplicates ${repeat.duplicates}`
  );

  /* ------------------------------------------------------- remote control */

  console.log('\nAssisted remote control — src/api/commands.ts');
  const support = await admin('POST', '/support-sessions', adminToken, { batteryId });
  const supportId = support.body.supportSessionId as string;

  const issued = await admin('POST', `/support-sessions/${supportId}/commands`, adminToken, {
    parameterKey: 'cell_ovp',
    value: 3.78,
    reason: 'Live check',
  });
  check(
    'the console can issue a change to a technician on site',
    issued.body.disposition === 'deliverable',
    issued.body.disposition
  );

  const claimed = await claimCommands(api, batteryId);
  check('the app collects it', claimed.length === 1, claimed.map((c) => c.parameterKey).join(', '));

  if (claimed[0]) {
    const reported = await reportResult(api, claimed[0].id, 'success');
    check('the app reports what the BMS did', reported, 'reported');
  }

  const again = await claimCommands(api, batteryId);
  check('nothing is handed over twice', again.length === 0, `${again.length} left`);

  const trail = await admin('GET', `/audit?batteryId=${batteryId}`, adminToken);
  const remote = (trail.body.events as { source: string; result: string }[]).filter(
    (e) => e.source === 'admin_remote' && e.result === 'success'
  );
  check('the ledger attributes it to the administrator', remote.length === 1, `${remote.length} event`);

  /* --------------------------------------------------------------- ending */

  console.log('\nEnding the link — src/api/presence.ts');
  await endPresence(api, batteryId);
  const after = await admin('GET', `/batteries/${batteryId}/session`, adminToken);
  check('the console sees the technician leave', after.body.active === false, 'active: false');

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed` +
      (failed.length ? ` — ${failed.map((f) => f.name).join(', ')}` : '') +
      '\n'
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nLive check failed:', error instanceof Error ? error.message : error, '\n');
  process.exit(1);
});
