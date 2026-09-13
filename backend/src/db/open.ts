import pg from 'pg';
import { createPostgresStore, createStore, migratePostgres, type Store } from './client.js';
import { seedParameterDefinitions } from '../policy/seed.js';
import { bootstrapCompany } from '../company/bootstrap.js';

/**
 * The store the process runs on, chosen by the environment.
 *
 * `DATABASE_URL` set means Postgres (Neon, in production): a pool over TLS,
 * the migration run, the parameters seeded and the company bootstrapped --
 * every one of which is idempotent, so a cold start is safe to repeat.
 * Unset means SQLite in `DATABASE_FILE`, which is development.
 *
 * `pg` returns BIGINT as strings; every such column here is a millisecond
 * timestamp or a count, all of which fit a JavaScript number.
 */
pg.types.setTypeParser(20, (value) => Number(value));

export interface Opened {
  store: Store;
  seeded: number;
  bootstrap: Awaited<ReturnType<typeof bootstrapCompany>>;
}

export async function openStore(env: NodeJS.ProcessEnv): Promise<Opened> {
  const store = env.DATABASE_URL
    ? createPostgresStore(
        new pg.Pool({
          connectionString: env.DATABASE_URL,
          // Neon requires TLS; a local Postgres usually has none.
          ssl: env.DATABASE_URL.includes('localhost') ? undefined : { rejectUnauthorized: true },
          // A serverless function is one request at a time; a long-lived
          // process can hold a few.
          max: env.VERCEL ? 2 : 8,
        })
      )
    : createStore(env.DATABASE_FILE ?? 'company.db');

  if (store.dialect === 'postgres') await migratePostgres(store);
  const seeded = await seedParameterDefinitions(store);

  // Only ever fires on a database with no users at all — see company/bootstrap.
  const bootstrap = await bootstrapCompany(store, {
    companyName: env.COMPANY_NAME,
    email: env.BOOTSTRAP_ADMIN_EMAIL,
    password: env.BOOTSTRAP_ADMIN_PASSWORD,
  });

  return { store, seeded, bootstrap };
}
