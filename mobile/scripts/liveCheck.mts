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
import { acceptInvitation } from '../src/api/invitations';
import { addPack, fetchCompany, invitePerson, listFleet, removePerson } from '../src/api/company';
import { listGateways, registerGateway, setGatewaySecurity } from '../src/api/gateways';
import { listLedger } from '../src/api/ledger';
import { closeSession, isSomeoneOnSite, issueCommand, openSession } from '../src/api/support';
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

/**
 * Plain fetch, for the few reads that verify what the app's own modules did —
 * looking at the ledger from the outside, checking presence from the outside.
 * Everything that *does* something goes through the module the app ships.
 */
async function raw(method: string, path: string, token: string | null, body?: unknown) {
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

const anonymous = () =>
  new ApiClient({
    baseUrl: API,
    getTokens: () => null,
    onTokens: () => undefined,
    onSignedOut: () => undefined,
  });

async function main() {
  console.log(`\nLive check against ${API}\n`);

  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`Cannot reach ${API}. Start the backend first.\n`);
    process.exit(1);
  }

  const adminEmail = process.env.ADMIN_EMAIL ?? 'ops@mebenergy.example';
  const adminPassword = process.env.ADMIN_PASSWORD ?? 'first-admin-passphrase';

  /* ------------------------------------------------- the administrator */

  console.log('The administrator — src/api/auth.ts, src/api/company.ts');
  let adminSession;
  try {
    adminSession = await login(anonymous(), adminEmail, adminPassword);
  } catch {
    console.error(
      `Could not sign in as ${adminEmail}. Bootstrap the company first, ` +
        `or set ADMIN_EMAIL and ADMIN_PASSWORD.\n`
    );
    process.exit(1);
  }
  check('the administrator signs in', adminSession.user.role === 'company', adminSession.user.role);
  const adminApi = clientFor(adminSession);
  const adminToken = adminSession.accessToken;

  const company = await fetchCompany(adminApi);
  check('the company is named', company.name.length > 0, company.name);
  check('the overview is counted by the server', company.overview.people.total >= 1,
    `${company.overview.people.total} people, ${company.overview.batteries.total} packs`);

  // Everything this run creates carries a stamp, so a repeated run does not
  // collide with the last one or with real data.
  const stamp = Date.now().toString(36);

  const techEmail = `live-${stamp}@check.example`;
  const invited = await invitePerson(adminApi, {
    email: techEmail,
    displayName: 'Live Check',
    role: 'user',
    permissions: { write: true },
  });
  check('a technician is invited, not given a password', !!invited.invitation?.token, invited.id.slice(0, 8));

  const techPassword = 'a-live-check-passphrase';
  const accepted = await acceptInvitation(anonymous(), invited.invitation!.token, techPassword);
  check('the invitation signs them straight in', accepted.user.email === techEmail, accepted.user.email);
  check('the link works once', await acceptInvitation(anonymous(), invited.invitation!.token, techPassword)
    .then(() => false).catch(() => true), 'second use refused');

  const { batteryId } = await addPack(adminApi, {
    serial: `LIVE-${stamp}`,
    chemistry: 'LiFePO4',
    cellCount: 24,
    bmsModel: profile.bmsModel,
  });
  check('a pack is registered', !!batteryId, batteryId.slice(0, 8));

  const fleet = await listFleet(adminApi);
  check('the fleet lists it', fleet.some((b) => b.id === batteryId), `${fleet.length} packs`);

  const gateway = await registerGateway(adminApi, {
    serial: `GW-${stamp}`,
    hardwareRevision: 'HW 1.0',
    firmwareVersion: 'FW 1.2.4',
    assignedBatteryId: batteryId,
  });
  await setGatewaySecurity(adminApi, gateway.id, 'quarantined');
  const gateways = await listGateways(adminApi);
  check('a gateway is registered and quarantined',
    gateways.find((g) => g.id === gateway.id)?.security_status === 'quarantined', 'quarantined');
  await setGatewaySecurity(adminApi, gateway.id, 'valid');

  /* ------------------------------------------------------------- sign in */

  console.log('\nSigning in — src/api/auth.ts');
  const session = await login(anonymous(), techEmail, techPassword);
  check('login returns a usable session', !!session.accessToken, session.user.email);
  check('login names the company', session.company?.name === company.name, session.company?.name ?? 'none');
  check('the technician is a technician', session.user.role === 'user', session.user.role);

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
  check('nobody is on site to begin with', (await isSomeoneOnSite(adminApi, batteryId)) === false, 'active: false');

  const presence = await announcePresence(api, batteryId);
  check('announcing presence opens a session', presence !== null, presence?.sessionId.slice(0, 8) ?? 'failed');

  check('the administrator can see the technician', (await isSomeoneOnSite(adminApi, batteryId)) === true, 'active: true');

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
  const stored = await raw('GET', `/batteries/${batteryId}/telemetry?limit=500`, adminToken);
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

  console.log('\nAssisted remote control — src/api/support.ts, src/api/commands.ts');
  const supportId = await openSession(adminApi, batteryId);

  const issued = await issueCommand(adminApi, supportId, {
    parameterKey: 'cell_ovp',
    value: 3.78,
    reason: 'Live check',
  });
  check(
    'the administrator can issue a change to a technician on site',
    issued.disposition === 'deliverable',
    issued.disposition
  );

  const claimed = await claimCommands(api, batteryId);
  check('the app collects it', claimed.length === 1, claimed.map((c) => c.parameterKey).join(', '));

  if (claimed[0]) {
    const reported = await reportResult(api, claimed[0].id, 'success');
    check('the app reports what the BMS did', reported, 'reported');
  }

  const again = await claimCommands(api, batteryId);
  check('nothing is handed over twice', again.length === 0, `${again.length} left`);

  const trail = await listLedger(adminApi, { batteryId });
  const remote = trail.filter((e) => e.source === 'admin_remote' && e.result === 'success');
  check('the ledger attributes it to the administrator', remote.length === 1, `${remote.length} event`);
  check('the ledger holds the on-site writes too', trail.filter((e) => e.source === 'local').length === 2,
    `${trail.filter((e) => e.source === 'local').length} local`);

  const cancelled = await closeSession(adminApi, supportId, 'Live check finished');
  check('closing the session leaves nothing queued', cancelled === 0, `${cancelled} cancelled`);

  /* --------------------------------------------------------------- ending */

  console.log('\nEnding the link — src/api/presence.ts');
  await endPresence(api, batteryId);
  check('the administrator sees the technician leave', (await isSomeoneOnSite(adminApi, batteryId)) === false, 'active: false');

  /* ------------------------------------------------------------- tidying */

  console.log('\nRemoving the technician — src/api/company.ts');
  const removal = await removePerson(adminApi, invited.id);
  // They have written to the ledger, so the account is kept as a record.
  check('a person with history is suspended rather than deleted', removal.removed === false && removal.reason === 'has_history',
    removal.removed ? 'deleted' : (removal.reason ?? 'suspended'));
  check('and can no longer sign in', await login(anonymous(), techEmail, techPassword).then(() => false).catch(() => true),
    'refused');

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
