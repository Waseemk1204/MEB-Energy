#!/usr/bin/env node
/**
 * Demo data, through the real API.
 *
 *   node scripts/seedDemo.mjs                       # against http://localhost:3000
 *   API=http://host:3000 node scripts/seedDemo.mjs
 *
 * Signs in as the bootstrapped administrator and creates technicians, packs,
 * gateways, a week of telemetry, on-site changes and a remote-support session
 * — every one of them through the same routes the app uses, so what appears
 * on screen is what the product actually does, not rows typed into a table.
 *
 * Safe to run more than once: anything that already exists is skipped.
 * Everything it makes carries "Demo" in its reasons so it can be told apart.
 */

const API = process.env.API ?? 'http://localhost:3000';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@mebenergy.example';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'change-this-password';

/** The technicians. Same password for all, printed at the end. */
const TECH_PASSWORD = 'technician-demo-2026';
const TECHNICIANS = [
  { email: 'priya@mebenergy.example', displayName: 'Priya Raman', permissions: { write: true } },
  { email: 'sam@mebenergy.example', displayName: 'Sam Field', permissions: { write: false } },
  { email: 'lena@mebenergy.example', displayName: 'Lena Okafor', permissions: { write: true, location: false } },
];
/** A second administrator, so the first is not the only one who can do anything. */
const SECOND_ADMIN = { email: 'ops@mebenergy.example', displayName: 'Ops Desk' };

const PACKS = ['MEB-24S-0101', 'MEB-24S-0102', 'MEB-24S-0103', 'MEB-24S-0104', 'MEB-24S-0105', 'MEB-24S-0106'];
const GATEWAYS = [
  { serial: 'GW-000184', hardwareRevision: 'HW 1.0', firmwareVersion: 'FW 1.2.4' },
  { serial: 'GW-000185', hardwareRevision: 'HW 1.0', firmwareVersion: 'FW 1.2.4' },
  { serial: 'GW-000190', hardwareRevision: 'HW 1.1', firmwareVersion: 'FW 1.3.0' },
];

async function call(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.message ?? text}`);
  return json;
}

const login = async (email, password) => call('POST', '/auth/login', null, { email, password });

const say = (line) => console.log(`  ${line}`);

async function main() {
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`Cannot reach ${API}. Start the backend first.`);
    process.exit(1);
  }

  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const A = admin.accessToken;
  console.log(`\nSeeding ${admin.company.name} at ${API}\n`);

  /* ---------------------------------------------------------------- people */
  console.log('People');
  const existing = (await call('GET', '/users', A)).users;
  const byEmail = new Map(existing.map((u) => [u.email, u]));

  const ensurePerson = async (person, role, password) => {
    if (byEmail.has(person.email)) {
      say(`${person.displayName} already exists`);
      return byEmail.get(person.email);
    }
    const created = await call('POST', '/users', A, { ...person, role });
    // Accept the invitation the way the person would, so the account is
    // usable with a known password.
    await call('POST', '/auth/accept-invite', null, { token: created.invitation.token, password });
    say(`${person.displayName} invited and accepted (${role === 'company' ? 'administrator' : 'technician'})`);
    return { id: created.id, email: person.email };
  };

  const techs = [];
  for (const t of TECHNICIANS) techs.push(await ensurePerson(t, 'user', TECH_PASSWORD));
  await ensurePerson(SECOND_ADMIN, 'company', TECH_PASSWORD);

  /* ----------------------------------------------------------------- packs */
  console.log('\nPacks');
  const fleet = (await call('GET', '/batteries?includeRetired=1', A)).batteries;
  const bySerial = new Map(fleet.map((b) => [b.serial, b]));
  const packs = [];
  for (const serial of PACKS) {
    if (bySerial.has(serial)) {
      say(`${serial} already exists`);
      packs.push(bySerial.get(serial));
      continue;
    }
    const { batteryId } = await call('POST', '/batteries', A, {
      serial,
      chemistry: 'LiFePO4',
      cellCount: 24,
      bmsModel: 'JBD SP24S004',
      capacityAh: 100,
    });
    await call('PATCH', `/batteries/${batteryId}`, A, {
      bmsManufacturer: 'Jiabaida',
      bmsFirmware: 'FW 1.2.4',
      nominalVoltage: 76.8,
      ratedCurrentA: 100,
    });
    packs.push({ id: batteryId, serial, status: 'active' });
    say(`${serial} registered`);
  }
  // One pack retired, so the fleet screen has both sections.
  const retired = packs[packs.length - 1];
  if (retired.status !== 'retired') {
    await call('DELETE', `/batteries/${retired.id}`, A);
    say(`${retired.serial} retired (kept in the record)`);
  }

  /* -------------------------------------------------------------- gateways */
  console.log('\nGateways');
  const devices = (await call('GET', '/devices', A)).devices;
  const gwBySerial = new Map(devices.map((d) => [d.serial, d]));
  for (const [i, g] of GATEWAYS.entries()) {
    if (gwBySerial.has(g.serial)) {
      say(`${g.serial} already exists`);
      continue;
    }
    const { id } = await call('POST', '/devices', A, { ...g, assignedBatteryId: packs[i]?.id ?? null });
    if (i === 2) {
      await call('PATCH', `/devices/${id}/security`, A, { securityStatus: 'quarantined' });
      say(`${g.serial} registered and quarantined`);
    } else {
      say(`${g.serial} registered, assigned to ${packs[i].serial}`);
    }
  }

  /* ------------------------------------------------- telemetry and history */
  console.log('\nTelemetry and history');
  const tech = await login(techs[0].email, TECH_PASSWORD);
  const T = tech.accessToken;

  const now = Date.now();
  const HOUR = 3_600_000;

  for (const [i, pack] of packs.slice(0, 4).entries()) {
    const already = (await call('GET', `/batteries/${pack.id}/telemetry?limit=1`, A)).readings.length > 0;
    if (already) {
      say(`${pack.serial} already has telemetry`);
      continue;
    }
    // A week of readings, one every two hours: a slow discharge with a
    // recharge every day and a half, and one pack that ran warm on Tuesday.
    const samples = [];
    for (let h = 7 * 24; h >= 0; h -= 2) {
      const at = now - h * HOUR - i * 17 * 60_000;
      const cycle = (h % 36) / 36;
      const soc = Math.round(95 - cycle * 60 + ((i * 7) % 5));
      const warm = i === 1 && h > 5 * 24 && h < 5 * 24 + 8;
      samples.push({
        recordedAt: at,
        soc,
        packVoltage: +(70 + (soc / 100) * 12).toFixed(2),
        packCurrent: +(cycle < 0.85 ? -(8 + (h % 5)) : 24).toFixed(1),
        temperatureC: warm ? 61 : 24 + (h % 7),
        minCellV: +(2.95 + (soc / 100) * 0.45).toFixed(3),
        maxCellV: +(2.98 + (soc / 100) * 0.47).toFixed(3),
        deltaMv: 18 + (h % 11),
        faultCount: warm ? 1 : 0,
        balancing: cycle > 0.9,
      });
    }
    await call('POST', `/batteries/${pack.id}/telemetry`, T, { samples });
    say(`${pack.serial}: ${samples.length} readings over the last week${i === 1 ? ', including an over-temperature episode' : ''}`);
  }

  const ledger = (await call('GET', '/audit', A)).events;
  if (ledger.some((e) => e.reason?.startsWith('Demo:'))) {
    say('on-site and remote changes already recorded');
  } else {
    // On-site changes by a technician, uploaded the way the app's outbox does.
    const events = [
      { pack: packs[0], key: 'cell_ovp', from: '3.750 V', to: '3.780 V', result: 'success', ago: 3 * 24 * HOUR, reason: 'Demo: vendor bulletin 2026-114' },
      { pack: packs[0], key: 'balance_start_v', from: '3.400 V', to: '3.450 V', result: 'success', ago: 3 * 24 * HOUR - 4 * 60_000, reason: 'Demo: balancing earlier on hot days' },
      { pack: packs[1], key: 'cell_uvp', from: '2.500 V', to: '2.450 V', result: 'indeterminate', ago: 26 * HOUR, reason: 'Demo: link dropped during the write' },
      { pack: packs[2], key: 'cell_ovp', from: '3.750 V', to: '4.300 V', result: 'rejected', ago: 5 * HOUR, reason: 'Demo: outside the permitted range' },
    ];
    for (const e of events) {
      await call('POST', `/batteries/${e.pack.id}/audit`, T, {
        events: [
          {
            clientEventId: `demo-${e.pack.serial}-${e.key}-${e.ago}`,
            parameterKey: e.key,
            oldValue: e.from,
            newValue: e.to,
            reason: e.reason,
            result: e.result,
            appVersion: '1.0.0',
            bmsFirmware: 'FW 1.2.4',
            occurredAt: now - e.ago,
          },
        ],
      });
    }
    say(`${events.length} on-site changes by ${techs[0].email}`);

    // A remote change, issued by the administrator while the technician was
    // at the pack, collected by their app and applied.
    await call('POST', `/batteries/${packs[0].id}/session`, T);
    const { supportSessionId } = await call('POST', '/support-sessions', A, { batteryId: packs[0].id });
    await call('POST', `/support-sessions/${supportSessionId}/commands`, A, {
      parameterKey: 'balance_delta_mv',
      value: 25,
      reason: 'Demo: remote change during a support call',
    });
    const claimed = (await call('POST', `/batteries/${packs[0].id}/commands/claim`, T)).commands;
    for (const c of claimed) await call('POST', `/commands/${c.id}/result`, T, { result: 'success' });
    await call('PATCH', `/support-sessions/${supportSessionId}`, A, { outcome: 'Demo: resolved on the call' });
    await call('DELETE', `/batteries/${packs[0].id}/session`, T);
    say(`1 remote change on ${packs[0].serial}, collected and applied`);
  }

  /* --------------------------------------------------------------- summary */
  const perms = (t) =>
    Object.entries({ read: true, write: false, location: true, health: true, ...t.permissions })
      .filter(([, v]) => !v)
      .map(([k]) => `no ${k}`)
      .join(', ') || 'all four permissions';

  console.log(`
Ready. Sign in with any of these:

  Administrator   ${ADMIN_EMAIL.padEnd(26)} ${ADMIN_PASSWORD}
  Administrator   ${SECOND_ADMIN.email.padEnd(26)} ${TECH_PASSWORD}
${TECHNICIANS.map((t) => `  Technician      ${t.email.padEnd(26)} ${TECH_PASSWORD}   (${perms(t)})`).join('\n')}
`);
}

main().catch((error) => {
  console.error('\nSeed failed:', error.message, '\n');
  process.exit(1);
});
