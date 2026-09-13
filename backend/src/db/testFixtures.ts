import type { Store } from './client.js';
import { createPostgresStore, createStore, migratePostgres } from './client.js';

/**
 * Test helpers. Exported from `src/` rather than a test directory because the
 * test runner compiles the whole tree; used only by tests.
 */

/**
 * A fresh store for a test.
 *
 * SQLite in memory by default: instant, and the shape every service was
 * written against. `TEST_DB=postgres` runs the same suite on PGlite -- a real
 * Postgres engine in-process -- so a query that is right on one dialect and
 * wrong on the other fails a test rather than a deploy. Both are run by
 * verify.sh.
 *
 * PGlite is started once per process and reset between tests by dropping the
 * schema, which is far cheaper than a new engine per test.
 */
export async function createTestStore(): Promise<Store> {
  if (process.env.TEST_DB !== 'postgres') return createStore();

  const engine = await pglite();
  await engine.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const store = createPostgresStore({
    query: (sql: string, params?: unknown[]) => engine.query(sql, params),
    exec: (sql: string) => engine.exec(sql),
    // Not closed per test: the engine is shared. `close` is a no-op here and
    // the process exit takes it down.
    close: async () => undefined,
  });
  await migratePostgres(store);
  return store;
}

interface Engine {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  exec(sql: string): Promise<unknown>;
}

let shared: Promise<Engine> | null = null;

function pglite(): Promise<Engine> {
  if (!shared) {
    shared = import('@electric-sql/pglite').then(({ PGlite }) => new PGlite() as unknown as Engine);
  }
  return shared;
}

/**
 * A company row for tests to put people and packs in.
 */
export async function seedCompany(store: Store, id: string, name: string, now = Date.now()): Promise<void> {
  await store.run(
    'INSERT INTO companies (id, name, status, created_at) VALUES (?,?,?,?)',
    id,
    name,
    'active',
    now
  );
}
