import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';

/**
 * Schema, and the guarantees that cannot live in application code.
 *
 * Plain SQL rather than an ORM, deliberately. Every query here either enforces
 * tenant isolation or writes the audit trail, and both are things a reviewer
 * should be able to read directly rather than infer from a query builder. The
 * scoping helpers in tenancy.ts make the isolation clause impossible to omit
 * without making it invisible.
 *
 * Two dialects, one schema. Postgres is production (Neon, behind Vercel);
 * `node:sqlite` is development and the fast test path. The SQL in the
 * services is written once with `?` placeholders and the Postgres store
 * rewrites them, so a query cannot be right on one and wrong on the other
 * without a test noticing -- the whole suite runs against both.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  -- Everybody belongs to the company. There is no tenantless account: the
  -- company's own administrator is the top of the hierarchy.
  company_id TEXT NOT NULL REFERENCES companies(id),
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  -- 'company' is the company's administrator, 'user' a technician.
  role TEXT NOT NULL CHECK (role IN ('company','user')),
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at BIGINT NOT NULL,

  -- What this person may do, set by their company. Separate from their role:
  -- the role says which tenant boundary they sit inside, these say what they
  -- may do within it. Write is off by default because granting it should be a
  -- decision somebody made, not something that happened.
  can_read INTEGER NOT NULL DEFAULT 1,
  can_write INTEGER NOT NULL DEFAULT 0,
  can_location INTEGER NOT NULL DEFAULT 1,
  can_health INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users(email);

-- An account created by invitation has no usable password until the person
-- accepts. Its status is 'invited', and login refuses anything that is not
-- 'active', so the account cannot be signed into in the meantime.
CREATE TABLE IF NOT EXISTS user_invitations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  -- Hashed, like a refresh token: a database dump must not hand someone every
  -- outstanding invitation.
  token_hash TEXT NOT NULL,
  invited_by TEXT NOT NULL REFERENCES users(id),
  expires_at BIGINT NOT NULL,
  accepted_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS invitation_token_idx ON user_invitations(token_hash);
CREATE INDEX IF NOT EXISTS invitation_user_idx ON user_invitations(user_id, accepted_at);
CREATE INDEX IF NOT EXISTS users_company_idx ON users(company_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT,
  replaced_by TEXT,
  -- What the person signed in on, so a session can be named.
  device_label TEXT,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS refresh_token_hash_idx ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS refresh_token_user_idx ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS batteries (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  serial TEXT NOT NULL,
  chemistry TEXT NOT NULL,
  cell_count INTEGER NOT NULL,
  nominal_voltage DOUBLE PRECISION,
  capacity_ah DOUBLE PRECISION,
  rated_current_a DOUBLE PRECISION,
  bms_manufacturer TEXT,
  bms_model TEXT,
  bms_firmware TEXT,
  -- Reserved for GPS-capable hardware (PRD §7.16); null until it exists, so
  -- adding location later needs no migration.
  latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, location_at BIGINT,
  -- Retired, never deleted. The audit ledger references packs by id, and a
  -- ledger entry pointing at a row that no longer exists is a ledger with a
  -- hole in it. A retired pack drops out of the technician's list and stays
  -- in the record.
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS batteries_company_idx ON batteries(company_id);
CREATE UNIQUE INDEX IF NOT EXISTS batteries_serial_idx ON batteries(serial);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  serial TEXT NOT NULL,
  hardware_revision TEXT NOT NULL,
  firmware_version TEXT NOT NULL,
  assigned_battery_id TEXT REFERENCES batteries(id),
  security_status TEXT NOT NULL DEFAULT 'valid'
    CHECK (security_status IN ('valid','revoked','quarantined')),
  -- The 32-byte key the gateway proves it holds (docs/BLE_CONTRACT.md §5),
  -- as 64 hex characters. Generated at registration, provisioned into the
  -- gateway once, and handed to the company's users so a technician with no
  -- signal can still verify the gateway in front of them.
  auth_key TEXT,
  last_seen_at BIGINT,
  latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, location_at BIGINT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_company_idx ON devices(company_id);
CREATE UNIQUE INDEX IF NOT EXISTS devices_serial_idx ON devices(serial);

CREATE TABLE IF NOT EXISTS parameter_definitions (
  id TEXT PRIMARY KEY,
  parameter_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  unit TEXT NOT NULL,
  data_type TEXT NOT NULL CHECK (data_type IN ('integer','float','boolean','enum')),
  min_value DOUBLE PRECISION NOT NULL,
  max_value DOUBLE PRECISION NOT NULL,
  danger_level TEXT NOT NULL CHECK (danger_level IN ('Normal','Warning','Critical')),
  supported_bms TEXT NOT NULL,
  readable INTEGER NOT NULL DEFAULT 1,
  writable INTEGER NOT NULL DEFAULT 0,
  requires_confirmation INTEGER NOT NULL DEFAULT 1,
  requires_admin INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS parameter_key_bms_idx
  ON parameter_definitions(parameter_key, supported_bms);

CREATE TABLE IF NOT EXISTS ble_sessions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  battery_id TEXT NOT NULL REFERENCES batteries(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  device_id TEXT REFERENCES devices(id),
  started_at BIGINT NOT NULL,
  last_heartbeat_at BIGINT NOT NULL,
  ended_at BIGINT
);
CREATE INDEX IF NOT EXISTS ble_sessions_battery_idx ON ble_sessions(battery_id, ended_at);
CREATE INDEX IF NOT EXISTS ble_sessions_company_idx ON ble_sessions(company_id);

CREATE TABLE IF NOT EXISTS support_sessions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  admin_user_id TEXT NOT NULL REFERENCES users(id),
  target_user_id TEXT REFERENCES users(id),
  battery_id TEXT NOT NULL REFERENCES batteries(id),
  started_at BIGINT NOT NULL,
  ended_at BIGINT,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS support_company_idx ON support_sessions(company_id);
CREATE INDEX IF NOT EXISTS support_battery_idx ON support_sessions(battery_id);

CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  support_session_id TEXT NOT NULL REFERENCES support_sessions(id),
  battery_id TEXT NOT NULL REFERENCES batteries(id),
  parameter_key TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  issued_by TEXT NOT NULL REFERENCES users(id),
  force_push INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL
    CHECK (state IN ('queued','claimed','completed','cancelled','expired')),
  created_at BIGINT NOT NULL,
  claimed_at BIGINT,
  settled_at BIGINT,
  result TEXT
);
CREATE INDEX IF NOT EXISTS commands_battery_state_idx ON commands(battery_id, state);
CREATE INDEX IF NOT EXISTS commands_company_idx ON commands(company_id);
CREATE INDEX IF NOT EXISTS commands_session_idx ON commands(support_session_id);

CREATE TABLE IF NOT EXISTS telemetry_readings (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  battery_id TEXT NOT NULL REFERENCES batteries(id),
  session_id TEXT REFERENCES ble_sessions(id),
  recorded_at BIGINT NOT NULL,
  soc DOUBLE PRECISION NOT NULL,
  pack_voltage DOUBLE PRECISION NOT NULL,
  pack_current DOUBLE PRECISION NOT NULL,
  temperature_c DOUBLE PRECISION NOT NULL,
  min_cell_v DOUBLE PRECISION NOT NULL,
  max_cell_v DOUBLE PRECISION NOT NULL,
  delta_mv DOUBLE PRECISION NOT NULL,
  fault_count INTEGER NOT NULL,
  balancing INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS telemetry_battery_time_idx
  ON telemetry_readings(battery_id, recorded_at);
CREATE INDEX IF NOT EXISTS telemetry_company_idx ON telemetry_readings(company_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  actor_role TEXT NOT NULL,
  battery_id TEXT REFERENCES batteries(id),
  device_id TEXT REFERENCES devices(id),
  parameter_key TEXT,
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  source TEXT NOT NULL CHECK (source IN ('local','admin_remote','admin_force_push')),
  result TEXT NOT NULL
    CHECK (result IN ('success','adjusted','rejected','timeout','indeterminate')),
  bms_response TEXT,
  app_version TEXT,
  device_firmware TEXT,
  bms_firmware TEXT,
  support_session_id TEXT,
  -- Supplied by the app for events it recorded itself while offline. It makes
  -- an upload retry idempotent: a technician whose connection dropped
  -- mid-upload must not end up with the same change recorded twice.
  client_event_id TEXT,
  occurred_at BIGINT NOT NULL,
  recorded_at BIGINT NOT NULL,
  -- Monotonic tiebreaker. Two events in the same millisecond would otherwise
  -- order arbitrarily, and an audit trail that cannot say which change came
  -- first is not much of an audit trail. On Postgres the database numbers it;
  -- on SQLite recordAudit computes MAX(seq) + 1, which is safe there because
  -- the connection is the only writer.
  seq __SEQ__
);
CREATE INDEX IF NOT EXISTS audit_seq_idx ON audit_events(seq);
CREATE INDEX IF NOT EXISTS audit_company_idx ON audit_events(company_id);
CREATE INDEX IF NOT EXISTS audit_battery_idx ON audit_events(battery_id);
CREATE INDEX IF NOT EXISTS audit_occurred_idx ON audit_events(occurred_at);
-- Unique per tenant. SQLite treats NULLs as distinct, so the server-generated
-- events that carry none are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS audit_client_event_idx
  ON audit_events(company_id, client_event_id);
`;

/** The one place the two dialects differ in DDL. */
export const SQLITE_SCHEMA =
  'PRAGMA foreign_keys = ON;\n' +
  SCHEMA.replace('__SEQ__', 'INTEGER NOT NULL') +
  `
-- PRD §8.1: append-only audit records. Enforced by the database, because the
-- trail has to hold even when something is actively trying to rewrite it. A
-- rule living only in a service method is one refactor away from being gone.
CREATE TRIGGER IF NOT EXISTS audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: updates are not permitted');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only: deletes are not permitted');
END;
`;

export const POSTGRES_SCHEMA =
  SCHEMA.replace('__SEQ__', 'BIGINT GENERATED BY DEFAULT AS IDENTITY NOT NULL') +
  `
-- The same append-only rule, as Postgres spells it. Statement-level, so a
-- bulk UPDATE or DELETE is refused even when it would touch no rows.
CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not permitted', lower(TG_OP);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();

DROP TRIGGER IF EXISTS audit_events_no_delete ON audit_events;
CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();
`;

export type Row = Record<string, unknown>;
export type Param = string | number | null;
export type Dialect = 'sqlite' | 'postgres';

/**
 * Every read and write in the application goes through this.
 *
 * Async because Postgres is; the SQLite store wraps a synchronous driver in
 * resolved promises so the services are written once. `transaction` runs its
 * function inside BEGIN/COMMIT on one connection: for Postgres that connection
 * is bound to the async context for the duration, so `store.run` inside the
 * function reaches it without the function having to be handed a handle.
 */
export interface Store {
  readonly dialect: Dialect;
  all<T = Row>(sql: string, ...params: Param[]): Promise<T[]>;
  get<T = Row>(sql: string, ...params: Param[]): Promise<T | undefined>;
  run(sql: string, ...params: Param[]): Promise<void>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/* ----------------------------------------------------------------- sqlite */

/**
 * Adds a column to an existing database that predates it.
 *
 * The schema is one idempotent script, which handles new tables but not new
 * columns on tables that already exist. This covers that gap without a
 * migration framework; it is deliberately additive only, since dropping or
 * retyping a column in a live audit ledger is not something a startup path
 * should ever do on its own.
 */
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, decl: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

/**
 * A database from before this was one company's application may hold
 * platform administrators: tenantless accounts with a role that no longer
 * exists. They cannot be deleted — the audit ledger may name them — so they
 * are suspended, which is what the login path checks. Nothing else about
 * them is touched.
 */
const RETIRE_LEGACY_ADMINS =
  "UPDATE users SET status = 'suspended' WHERE role = 'admin' AND status <> 'suspended'";

/**
 * The development and test store. Migration runs synchronously in the
 * constructor, so a test can hold a ready database without awaiting one.
 */
export function createStore(file = ':memory:'): Store {
  const db = new DatabaseSync(file);

  // SQLite applies DDL transactionally, and the migration must be all-or-
  // nothing. Without this, a statement that fails partway leaves the earlier
  // tables created — and because every statement is `IF NOT EXISTS`, the next
  // startup skips straight over them and the database stays permanently
  // half-built with no error to show for it.
  db.exec('BEGIN');
  try {
    db.exec(SQLITE_SCHEMA);
    addColumnIfMissing(db, 'audit_events', 'client_event_id', 'TEXT');
    addColumnIfMissing(db, 'refresh_tokens', 'device_label', 'TEXT');
    // Existing accounts inherit the defaults: they can read, see location and
    // see health, and nobody silently gains write.
    addColumnIfMissing(db, 'users', 'can_read', 'INTEGER NOT NULL DEFAULT 1');
    addColumnIfMissing(db, 'users', 'can_write', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'users', 'can_location', 'INTEGER NOT NULL DEFAULT 1');
    addColumnIfMissing(db, 'users', 'can_health', 'INTEGER NOT NULL DEFAULT 1');
    addColumnIfMissing(db, 'batteries', 'status', "TEXT NOT NULL DEFAULT 'active'");
    addColumnIfMissing(db, 'devices', 'auth_key', 'TEXT');
    db.prepare(RETIRE_LEGACY_ADMINS).run();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }

  return {
    dialect: 'sqlite',
    all: async <T = Row>(sql: string, ...params: Param[]) =>
      db.prepare(sql).all(...params) as T[],
    get: async <T = Row>(sql: string, ...params: Param[]) =>
      db.prepare(sql).get(...params) as T | undefined,
    run: async (sql: string, ...params: Param[]) => {
      db.prepare(sql).run(...params);
    },
    exec: async (sql: string) => db.exec(sql),
    // One connection, so an async function between BEGIN and COMMIT is still
    // the only writer; nothing else can reach the database in the gaps.
    transaction: async <T>(fn: () => Promise<T>): Promise<T> => {
      db.exec('BEGIN');
      try {
        const result = await fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close: async () => db.close(),
  };
}

/* --------------------------------------------------------------- postgres */

/** The slice of a Postgres client the store needs; `pg` and PGlite both fit. */
export interface PgQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  /**
   * Several statements in one string, as a migration is. `pg` runs an
   * unparameterised `query` through the simple protocol, which allows that;
   * PGlite's `query` is always a prepared statement and needs its `exec`.
   */
  exec?: (sql: string) => Promise<unknown>;
}

/** A pool hands out connections; a single client is its own connection. */
export interface PgPoolLike extends PgQueryable {
  connect?: () => Promise<PgQueryable & { release: () => void }>;
  end?: () => Promise<void>;
  close?: () => Promise<void>;
}

/**
 * `?` to `$1, $2, …`. The services are written with SQLite's placeholder, and
 * no SQL in this codebase carries a literal question mark in a string, so a
 * plain scan is enough. Quoted strings are still skipped, so one arriving
 * later does not silently shift every parameter after it.
 */
export function toPositional(sql: string): string {
  let n = 0;
  let out = '';
  let quote: string | null = null;
  for (const ch of sql) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === '?') {
      n += 1;
      out += `$${n}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/** `pg` returns BIGINT and COUNT(*) as strings; every such value here fits a number. */
function normalise(row: Row): Row {
  for (const key of Object.keys(row)) {
    const v = row[key];
    if (typeof v === 'bigint') row[key] = Number(v);
    else if (typeof v === 'string' && /^-?\d{1,15}$/.test(v) && BIG_COLUMNS.has(key)) row[key] = Number(v);
  }
  return row;
}

/** Columns the schema declares BIGINT, plus the aliases counts arrive under. */
const BIG_COLUMNS = new Set([
  'created_at', 'start_date', 'renewal_date', 'expires_at', 'accepted_at', 'revoked_at',
  'location_at', 'last_seen_at', 'started_at', 'last_heartbeat_at', 'ended_at', 'claimed_at',
  'settled_at', 'recorded_at', 'occurred_at', 'seq', 'n', 'count',
]);

/**
 * The production store.
 *
 * Takes a connected client or pool rather than a URL, so the same code runs
 * against Neon through `pg` and against PGlite in the test suite. Call
 * {@link migratePostgres} once before use.
 */
export function createPostgresStore(pg: PgPoolLike): Store {
  const bound = new AsyncLocalStorage<PgQueryable>();
  const current = (): PgQueryable => bound.getStore() ?? pg;

  const query = async (sql: string, params: Param[]) => {
    const result = await current().query(toPositional(sql), params);
    return result.rows.map(normalise);
  };

  return {
    dialect: 'postgres',
    all: async <T = Row>(sql: string, ...params: Param[]) => (await query(sql, params)) as T[],
    get: async <T = Row>(sql: string, ...params: Param[]) =>
      (await query(sql, params))[0] as T | undefined,
    run: async (sql: string, ...params: Param[]) => {
      await query(sql, params);
    },
    exec: async (sql: string) => {
      const c = current();
      if (c.exec) await c.exec(sql);
      else await c.query(sql);
    },
    transaction: async <T>(fn: () => Promise<T>): Promise<T> => {
      // Already inside one: Postgres has no nested transactions, and the
      // outer COMMIT or ROLLBACK covers this work too.
      if (bound.getStore()) return fn();

      // A pool must run the whole transaction on one connection, or BEGIN
      // lands on one and the writes on another. A single client is its own.
      const leased = pg.connect ? await pg.connect() : null;
      const client: PgQueryable = leased ?? pg;
      try {
        await client.query('BEGIN');
        const result = await bound.run(client, fn);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        leased?.release();
      }
    },
    close: async () => {
      if (pg.end) await pg.end();
      else if (pg.close) await pg.close();
    },
  };
}

/** Idempotent; safe on every cold start. */
export async function migratePostgres(store: Store): Promise<void> {
  await store.exec(POSTGRES_SCHEMA);
  await store.run(RETIRE_LEGACY_ADMINS);
}
