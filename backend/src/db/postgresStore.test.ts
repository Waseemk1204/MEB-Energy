import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresStore, toPositional, type PgPoolLike, type PgQueryable } from './client.js';

/**
 * The Postgres store's own rules, against a fake pool.
 *
 * The suite runs on PGlite, which is one connection, so it cannot see the
 * one thing a pool gets wrong: a transaction whose BEGIN lands on one
 * connection and whose writes land on another. That is no transaction at
 * all, and it is invisible until production. Hence a fake with two.
 */

interface Call {
  who: string;
  sql: string;
  params: unknown[] | undefined;
}

function fakePool(): { pool: PgPoolLike; calls: Call[]; released: number } {
  const state = { calls: [] as Call[], released: 0 };
  const client = (who: string): PgQueryable => ({
    query: async (sql, params) => {
      state.calls.push({ who, sql, params });
      return { rows: [{ who, n: '3', created_at: '1700000000000' }] };
    },
  });
  const pool: PgPoolLike = {
    ...client('pool'),
    connect: async () => ({ ...client('leased'), release: () => (state.released += 1) }),
  };
  return { pool, get calls() { return state.calls; }, get released() { return state.released; } };
}

describe('placeholders', () => {
  it('rewrites ? to numbered parameters', () => {
    assert.equal(toPositional('SELECT * FROM t WHERE a = ? AND b = ?'), 'SELECT * FROM t WHERE a = $1 AND b = $2');
  });

  it('leaves a question mark inside a string literal alone', () => {
    assert.equal(toPositional("SELECT '?' AS q, ? AS p"), "SELECT '?' AS q, $1 AS p");
  });

  it('numbers every parameter in order', () => {
    assert.equal(toPositional('(?,?,?,?)'), '($1,$2,$3,$4)');
  });
});

describe('reading rows', () => {
  it('turns the strings pg uses for BIGINT into numbers', async () => {
    const { pool } = fakePool();
    const store = createPostgresStore(pool);
    const row = await store.get<{ n: number; created_at: number }>('SELECT 1');
    assert.equal(row?.n, 3);
    assert.equal(row?.created_at, 1_700_000_000_000);
  });
});

describe('transactions on a pool', () => {
  it('run BEGIN, the work and COMMIT on one leased connection', async () => {
    const fake = fakePool();
    const store = createPostgresStore(fake.pool);

    await store.transaction(async () => {
      await store.run('INSERT INTO t VALUES (?)', 1);
      await store.get('SELECT 1');
    });

    const who = fake.calls.map((c) => `${c.who}:${c.sql.split(' ')[0]}`);
    assert.deepEqual(who, ['leased:BEGIN', 'leased:INSERT', 'leased:SELECT', 'leased:COMMIT']);
    assert.equal(fake.released, 1);
  });

  it('roll back on the same connection and still release it', async () => {
    const fake = fakePool();
    const store = createPostgresStore(fake.pool);

    await assert.rejects(
      store.transaction(async () => {
        await store.run('INSERT INTO t VALUES (?)', 1);
        throw new Error('no');
      }),
      /no/
    );
    assert.equal(fake.calls.at(-1)?.who, 'leased');
    assert.equal(fake.calls.at(-1)?.sql, 'ROLLBACK');
    assert.equal(fake.released, 1);
  });

  it('send queries outside a transaction to the pool', async () => {
    const fake = fakePool();
    const store = createPostgresStore(fake.pool);
    await store.get('SELECT 1');
    assert.equal(fake.calls[0]?.who, 'pool');
  });

  /** Two transactions interleaving must not see each other's connection. */
  it('keep concurrent transactions on their own connections', async () => {
    const fake = fakePool();
    const store = createPostgresStore(fake.pool);
    let leases = 0;
    fake.pool.connect = async () => {
      leases += 1;
      const who = `leased-${leases}`;
      return {
        query: async (sql, params) => {
          fake.calls.push({ who, sql, params });
          return { rows: [] };
        },
        release: () => undefined,
      };
    };

    await Promise.all([
      store.transaction(async () => {
        await new Promise((r) => setTimeout(r, 5));
        await store.run('INSERT INTO a VALUES (1)');
      }),
      store.transaction(async () => {
        await store.run('INSERT INTO b VALUES (1)');
      }),
    ]);

    const a = fake.calls.find((c) => c.sql.includes('INTO a'));
    const b = fake.calls.find((c) => c.sql.includes('INTO b'));
    assert.notEqual(a?.who, b?.who);
    for (const c of fake.calls) {
      if (c.sql.includes('INTO a')) assert.equal(c.who, a?.who);
    }
  });

  it('treat a transaction inside a transaction as the same one', async () => {
    const fake = fakePool();
    const store = createPostgresStore(fake.pool);
    await store.transaction(async () => {
      await store.transaction(async () => {
        await store.run('INSERT INTO t VALUES (1)');
      });
    });
    assert.equal(fake.calls.filter((c) => c.sql === 'BEGIN').length, 1);
    assert.equal(fake.released, 1);
  });
});
