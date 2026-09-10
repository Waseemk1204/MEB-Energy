import { createStore } from './db/client.js';
import { secretFrom } from './auth/tokens.js';
import { seedParameterDefinitions } from './policy/seed.js';
import { bootstrapAdmin } from './admin/bootstrap.js';
import { parseOrigins } from './http/cors.js';
import { buildServer } from './server.js';
import type { Dispatcher } from './policy/writeService.js';

/**
 * Process entrypoint.
 *
 * The dispatcher is a stub. Real commands travel Admin → Cloud → User's app →
 * BLE → gateway → UART → BMS (PRD §7.3), and the two hops after the cloud do
 * not exist yet. Rather than pretend, this refuses every dispatch — the policy
 * engine and the audit trail are still exercised end to end, and a refusal is
 * recorded honestly instead of a success being invented.
 */
const notWiredYet: Dispatcher = {
  send: async () => {
    throw new Error('Command broker is not wired: no device path exists yet');
  },
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required. Refusing to start with a default secret — a shared ` +
        `signing key across deployments is exactly what PRD §8.1 forbids.`
    );
  }
  return value;
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
  const dbFile = process.env.DATABASE_FILE ?? 'knowyourev.db';

  const store = createStore(dbFile);
  const seeded = seedParameterDefinitions(store);

  // Only ever fires on a database with no users at all — see admin/bootstrap.
  const bootstrap = await bootstrapAdmin(store, {
    email: process.env.BOOTSTRAP_ADMIN_EMAIL,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  });
  if (bootstrap.kind === 'created') {
    console.log(`Created the first administrator: ${bootstrap.email}`);
  } else if (bootstrap.reason === 'not_configured') {
    const empty = store.get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
    if ((empty?.n ?? 0) === 0) {
      console.warn(
        'No users exist and no BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD were set. ' +
          'Nobody can sign in until one is created.'
      );
    }
  }

  const corsOrigins = parseOrigins(process.env.CORS_ORIGINS);
  if (corsOrigins.length === 0) {
    console.warn(
      'CORS_ORIGINS is not set. The API will refuse every browser client, ' +
        'including the admin console. Set it to the console origin, e.g. ' +
        'CORS_ORIGINS=https://console.knowyourev.example'
    );
  }

  const app = buildServer({
    store,
    secret: secretFrom(requiredEnv('JWT_SECRET')),
    dispatcher: notWiredYet,
    corsOrigins,
  });

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, closing`);
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port, host: '0.0.0.0' });
  console.log(`KnowyourEV backend listening on :${port} (db ${dbFile}, ${seeded} parameters)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
