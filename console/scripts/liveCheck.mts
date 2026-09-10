/**
 * Drive the console's own modules against a running backend.
 *
 * The sibling of `mobile/scripts/liveCheck.mts`, and for the same reason. Every
 * one of this package's tests injects a `fetchImpl`, which is exactly the
 * arrangement that hid the client's `fetch` binding bug: the console could not
 * make a single request in a browser while 71 tests passed, because none of
 * them ever took the default branch.
 *
 * So nothing here is stubbed. Each call goes through the module the console
 * actually ships, against a real server.
 *
 *   cd backend && npm run dev
 *   cd console && npm run live-check
 */

import { ApiClient } from '../src/api/client';
import { listBatteries, getBattery, describeReading, byAttention } from '../src/api/fleet';
import { listHistory, toSeries, GAP_MS } from '../src/api/history';
import { listAudit } from '../src/api/audit';
import {
  listUsers,
  listDevices,
  listCompanies,
  inviteUser,
  invitationLink,
  acceptInvitation,
  registerDevice,
  setDeviceSecurity,
  seatUsage,
  getEntitlement,
  adjustLimits,
  DEFAULT_SESSION_DEVICES,
} from '../src/api/admin';
import {
  openSession,
  closeSession,
  issueCommand,
  isSomeoneOnSite,
  parametersFor,
} from '../src/api/support';

const API = process.env.API ?? 'http://localhost:3000';

const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail: string) => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(50)} ${detail}`);
};

function clientFor(accessToken: string, refreshToken = 'unused') {
  let tokens = { accessToken, refreshToken };
  return new ApiClient({
    baseUrl: API,
    getTokens: () => tokens,
    onTokens: (next) => {
      tokens = next;
    },
    onSignedOut: () => console.log('  ! the client signed itself out'),
  });
}

/** The technician's side, which the console does not implement. */
async function asTechnician(method: string, path: string, token: string, body?: unknown) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      authorization: `Bearer ${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function main() {
  console.log(`\nKnowyourEV console live check against ${API}\n`);

  if (!(await fetch(`${API}/health`).catch(() => null))?.ok) {
    console.error(`Cannot reach ${API}. Start the backend first.\n`);
    process.exit(1);
  }

  const email = process.env.ADMIN_EMAIL ?? 'ops@knowyourev.example';
  const password = process.env.ADMIN_PASSWORD ?? 'first-admin-passphrase';

  /* ------------------------------------------------------------- sign in */

  console.log('Signing in — src/api/client.ts');
  const anon = new ApiClient({
    baseUrl: API,
    getTokens: () => null,
    onTokens: () => undefined,
    onSignedOut: () => undefined,
  });

  const session = await anon.anon<{
    accessToken: string;
    refreshToken: string;
    user: { role: string };
    company: unknown;
  }>('/auth/login', { email, password });

  check('the real client can sign in', !!session.accessToken, session.user.role);
  check('an administrator belongs to no company', session.company === null, 'company: null');

  const api = clientFor(session.accessToken, session.refreshToken);
  const stamp = Date.now().toString(36);

  /* ----------------------------------------------------------- companies */

  console.log('\nCompanies — src/api/admin.ts');
  const before = await listCompanies(api);
  await api.post('/companies', {
    name: `Console check ${stamp}`,
    seatLimit: 5,
    batteryLimit: 5,
  });
  const after = await listCompanies(api);
  check('creating a tenant shows up in the listing', after.length === before.length + 1,
    `${before.length} -> ${after.length}`);

  const company = after.find((c) => c.name === `Console check ${stamp}`)!;
  check('the listing maps the wire shape', typeof company.createdAt === 'number',
    new Date(company.createdAt).toISOString().slice(0, 10));

  /* --------------------------------------------------------- entitlement */

  console.log('\nEntitlement — src/api/admin.ts');
  const granted = await getEntitlement(api, company.id);
  check('a new company can be used', granted.ok, granted.code);
  check('its seat limit is what was bought', granted.seats.limit === 5,
    String(granted.seats.limit));

  /*
   * Two different limits, both about "devices": KnowyourEV gateways, and the
   * phones and browsers the owner account may be signed in on. They are read
   * back separately here because conflating them is the standing hazard, and
   * a live check is where a wrong column would actually show.
   */
  check('the sign-in cap defaults to two',
    granted.sessionDevices.limit === DEFAULT_SESSION_DEVICES,
    String(granted.sessionDevices.limit));
  check('nobody is signed in on it yet', granted.sessionDevices.used === 0,
    String(granted.sessionDevices.used));

  await adjustLimits(api, company.id, { deviceLimit: 40 });
  const gatewaysRaised = await getEntitlement(api, company.id);
  check('raising the gateway limit leaves the sign-in cap alone',
    gatewaysRaised.devices.limit === 40 && gatewaysRaised.sessionDevices.limit === 2,
    `gateways ${gatewaysRaised.devices.limit}, sign-ins ${gatewaysRaised.sessionDevices.limit}`);

  await adjustLimits(api, company.id, { sessionDeviceLimit: 6 });
  const signInsRaised = await getEntitlement(api, company.id);
  check('raising the sign-in cap leaves the gateway limit alone',
    signInsRaised.sessionDevices.limit === 6 && signInsRaised.devices.limit === 40,
    `gateways ${signInsRaised.devices.limit}, sign-ins ${signInsRaised.sessionDevices.limit}`);

  const term = signInsRaised.expiresAt ?? 0;
  check('changing a limit did not restart the year',
    term > Date.now() && term - Date.now() < 366 * 24 * 60 * 60 * 1000,
    new Date(term).toISOString().slice(0, 10));

  /* --------------------------------------------------------- invitations */

  console.log('\nInvitations — src/api/admin.ts');
  const invited = await inviteUser(api, {
    companyId: company.id,
    email: `owner-${stamp}@check.example`,
    displayName: 'Console Check',
    role: 'company',
  });
  check('a new user is created by invitation', invited.status === 'invited', invited.status);
  check('a single-use token comes back once', !!invited.invitation?.token,
    invited.invitation ? `${invited.invitation.token.slice(0, 8)}…` : 'none');

  const link = invitationLink(invited.invitation!.token, 'https://console.example');
  check('the link points at the accept screen', link.includes('/accept-invite?token='),
    link.slice(0, 46) + '…');

  const accepted = await acceptInvitation(anon, invited.invitation!.token, 'their-own-passphrase');
  check('accepting it signs the person straight in',
    !!(accepted as { accessToken?: string }).accessToken, 'signed in');

  const reused = await acceptInvitation(anon, invited.invitation!.token, 'somebody-elses-x')
    .then(() => 'accepted')
    .catch(() => 'refused');
  check('the link works exactly once', reused === 'refused', reused);

  /* ----------------------------------------------------------- users */

  console.log('\nUsers and seats — src/api/admin.ts');
  const users = await listUsers(api);
  check('the new user appears', users.some((u) => u.email === `owner-${stamp}@check.example`),
    `${users.length} users`);

  const seats = await seatUsage(api, company.id);
  check('seat usage is reported against the plan', seats.limit === 5, `${seats.used} of ${seats.limit}`);

  /* ---------------------------------------------------------- batteries */

  console.log('\nFleet — src/api/fleet.ts');
  const techEmail = `tech-${stamp}@check.example`;
  await api.post('/users', {
    companyId: company.id,
    email: techEmail,
    displayName: 'Tech',
    role: 'user',
    password: 'a-technician-passphrase',
  });

  for (const n of [1, 2]) {
    await api.post('/batteries', {
      companyId: company.id,
      serial: `CONSOLE-${stamp}-${n}`,
      chemistry: 'LiFePO4',
      cellCount: 24,
      bmsModel: 'JBD SP24S004',
    });
  }

  const fleet = await listBatteries(api);
  const mine = fleet.batteries.filter((b) => b.serial.startsWith(`CONSOLE-${stamp}`));
  check('both packs are listed', mine.length === 2, `${mine.length} of 2`);
  check('a fleet that fits is not reported truncated', fleet.truncated === false, 'truncated: false');

  const never = describeReading(mine[0]!.lastReading);
  check('a pack that has never reported claims nothing', never.soc === '—' && !never.known,
    `${never.soc} · ${never.age}`);

  const one = await getBattery(api, mine[0]!.id);
  check('one battery can be fetched directly', one.serial === mine[0]!.serial, one.serial);

  /* ---------------------------------------------------------- telemetry */

  console.log('\nHistory — src/api/history.ts');
  const techToken = (
    await anon.anon<{ accessToken: string }>('/auth/login', {
      email: techEmail,
      password: 'a-technician-passphrase',
    })
  ).accessToken;

  const now = Date.now();
  const sample = (at: number, soc: number, faults = 0) => ({
    recordedAt: at,
    soc,
    packVoltage: 79.2,
    packCurrent: -12,
    temperatureC: 24,
    minCellV: 3.28,
    maxCellV: 3.31,
    deltaMv: 30,
    faultCount: faults,
  });

  // Two reporting sessions three hours apart, so the series has a real gap.
  await asTechnician('POST', `/batteries/${mine[0]!.id}/telemetry`, techToken, {
    samples: [
      ...Array.from({ length: 6 }, (_, i) => sample(now - 3 * 3600_000 + i * 10_000, 80 - i)),
      ...Array.from({ length: 6 }, (_, i) => sample(now - 60_000 + i * 10_000, 60 - i)),
    ],
  });

  const readings = await listHistory(api, mine[0]!.id);
  check('the history comes back oldest first', readings.length > 0 &&
    readings[0]!.recordedAt < readings[readings.length - 1]!.recordedAt, `${readings.length} readings`);

  const series = toSeries(readings, (r) => r.soc);
  check('the reporting gap is found, not drawn through', series.breaks.length === 1,
    `${series.breaks.length} break (threshold ${GAP_MS / 1000}s)`);

  const withReading = await getBattery(api, mine[0]!.id);
  const summary = describeReading(withReading.lastReading);
  check('a pack that has reported shows a charge with its age', summary.known,
    `${summary.soc} · ${summary.age}`);

  const sorted = [...(await listBatteries(api)).batteries].sort(byAttention);
  check('sorting puts something at the top', sorted.length > 0, sorted[0]!.serial);

  /* ------------------------------------------------------- remote support */

  console.log('\nRemote support — src/api/support.ts');
  const parameters = await parametersFor(api, 'JBD SP24S004');
  const writable = parameters.filter((p) => p.writable);
  check('the console reads the BMS profile', writable.length > 0,
    `${writable.length} writable of ${parameters.length}`);

  check('nobody is on site to begin with',
    (await isSomeoneOnSite(api, mine[0]!.id)) === false, 'false');

  const supportId = await openSession(api, mine[0]!.id);
  const queued = await issueCommand(api, supportId, {
    parameterKey: 'cell_ovp',
    value: 3.78,
    reason: 'Console live check',
  });
  check('a change issued with nobody on site is queued', queued.disposition === 'queued',
    queued.disposition);

  await asTechnician('POST', `/batteries/${mine[0]!.id}/session`, techToken);
  check('the console sees a technician arrive',
    (await isSomeoneOnSite(api, mine[0]!.id)) === true, 'true');

  const deliverable = await issueCommand(api, supportId, {
    parameterKey: 'balance_start_v',
    value: 3.41,
    reason: 'Console live check',
  });
  check('a change issued with somebody on site is deliverable',
    deliverable.disposition === 'deliverable', deliverable.disposition);

  const refused = await issueCommand(api, supportId, {
    parameterKey: 'cell_ovp',
    value: 4.2,
    reason: 'Deliberately out of range',
  })
    .then(() => 'accepted')
    .catch((e: Error) => e.message);
  check('the server refuses a value out of range', refused !== 'accepted', String(refused));

  const cancelled = await closeSession(api, supportId, 'Console live check finished');
  check('closing the session cancels what it queued', cancelled >= 1, `${cancelled} cancelled`);

  /* --------------------------------------------------------------- audit */

  console.log('\nAudit — src/api/audit.ts');
  const all = await listAudit(api);
  check('the trail is readable', all.length > 0, `${all.length} events`);

  const forPack = await listAudit(api, { batteryId: mine[0]!.id });
  check('filtering by battery goes to the server',
    forPack.every((e) => e.batteryId === mine[0]!.id), `${forPack.length} for this pack`);

  const refusals = await listAudit(api, { result: 'rejected' });
  check('filtering by outcome finds the refusal',
    refusals.length > 0 && refusals.every((e) => e.result === 'rejected'),
    `${refusals.length} refused`);

  const remote = await listAudit(api, { source: 'admin_remote' });
  check('filtering by source works too',
    remote.every((e) => e.source === 'admin_remote'), `${remote.length} remote`);

  /* ------------------------------------------------------------- devices */

  console.log('\nDevices — src/api/admin.ts');
  const device = await registerDevice(api, {
    companyId: company.id,
    serial: `KYE-${stamp}`,
    hardwareRevision: 'rev-C',
    firmwareVersion: '1.4.2',
  });
  const devices = await listDevices(api);
  const registered = devices.find((d) => d.id === device.id)!;
  check('a gateway can be registered', registered.securityStatus === 'valid',
    registered.securityStatus);

  await setDeviceSecurity(api, device.id, 'quarantined');
  const quarantined = (await listDevices(api)).find((d) => d.id === device.id)!;
  check('and taken out of service', quarantined.securityStatus === 'quarantined',
    quarantined.securityStatus);

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
