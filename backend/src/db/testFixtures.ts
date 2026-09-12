import type { Store } from './client.js';

/**
 * A company row for tests to put people and packs in.
 *
 * Exported from `src/` rather than a test directory because the test runner
 * compiles the whole tree; it is used only by tests.
 */
export function seedCompany(store: Store, id: string, name: string, now = Date.now()): void {
  store.run(
    'INSERT INTO companies (id, name, status, created_at) VALUES (?,?,?,?)',
    id,
    name,
    'active',
    now
  );
}
