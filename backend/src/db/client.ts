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
 * `node:sqlite` is the dev and test store. Production is Postgres; the SQL here
 * is kept portable, and nothing depends on SQLite-specific behaviour except the
 * append-only triggers, which have direct Postgres equivalents.
 */

export const MIGRATION = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  created_at INTEGER NOT NULL
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
  created_at INTEGER NOT NULL,

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
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS invitation_token_idx ON user_invitations(token_hash);
CREATE INDEX IF NOT EXISTS invitation_user_idx ON user_invitations(user_id, accepted_at);
CREATE INDEX IF NOT EXISTS users_company_idx ON users(company_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  replaced_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS refresh_token_hash_idx ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS refresh_token_user_idx ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS batteries (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  serial TEXT NOT NULL,
  chemistry TEXT NOT NULL,
  cell_count INTEGER NOT NULL,
  nominal_voltage REAL,
  capacity_ah REAL,
  rated_current_a REAL,
  bms_manufacturer TEXT,
  bms_model TEXT,
  bms_firmware TEXT,
  -- Reserved for GPS-capable hardware (PRD §7.16); null until it exists, so
  -- adding location later needs no migration.
  latitude REAL, longitude REAL, location_at INTEGER,
  -- Retired, never deleted. The audit ledger references packs by id, and a
  -- ledger entry pointing at a row that no longer exists is a ledger with a
  -- hole in it. A retired pack drops out of the technician's list and stays
  -- in the record.
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at INTEGER NOT NULL
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
  last_seen_at INTEGER,
  latitude REAL, longitude REAL, location_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_company_idx ON devices(company_id);
CREATE UNIQUE INDEX IF NOT EXISTS devices_serial_idx ON devices(serial);

CREATE TABLE IF NOT EXISTS parameter_definitions (
  id TEXT PRIMARY KEY,
  parameter_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  unit TEXT NOT NULL,
  data_type TEXT NOT NULL CHECK (data_type IN ('integer','float','boolean','enum')),
  min_value REAL NOT NULL,
  max_value REAL NOT NULL,
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
  started_at INTEGER NOT NULL,
  last_heartbeat_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS ble_sessions_battery_idx ON ble_sessions(battery_id, ended_at);
CREATE INDEX IF NOT EXISTS ble_sessions_company_idx ON ble_sessions(company_id);

CREATE TABLE IF NOT EXISTS support_sessions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  admin_user_id TEXT NOT NULL REFERENCES users(id),
  target_user_id TEXT REFERENCES users(id),
  battery_id TEXT NOT NULL REFERENCES batteries(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
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
  value REAL NOT NULL,
  issued_by TEXT NOT NULL REFERENCES users(id),
  force_push INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL
    CHECK (state IN ('queued','claimed','completed','cancelled','expired')),
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  settled_at INTEGER,
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
  recorded_at INTEGER NOT NULL,
  soc REAL NOT NULL,
  pack_voltage REAL NOT NULL,
  pack_current REAL NOT NULL,
  temperature_c REAL NOT NULL,
  min_cell_v REAL NOT NULL,
  max_cell_v REAL NOT NULL,
  delta_mv REAL NOT NULL,
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
  occurred_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  -- Monotonic tiebreaker. Two events in the same millisecond would otherwise
  -- order arbitrarily, and an audit trail that cannot say which change came
  -- first is not much of an audit trail.
  -- Postgres: replace with BIGSERIAL and drop the expression in recordAudit.
  seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_seq_idx ON audit_events(seq);
CREATE INDEX IF NOT EXISTS audit_company_idx ON audit_events(company_id);
CREATE INDEX IF NOT EXISTS audit_battery_idx ON audit_events(battery_id);
CREATE INDEX IF NOT EXISTS audit_occurred_idx ON audit_events(occurred_at);
-- Unique per tenant. SQLite treats NULLs as distinct, so the server-generated
-- events that carry none are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS audit_client_event_idx
  ON audit_events(company_id, client_event_id);

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

export type Row = Record<string, unknown>;
export type Param = string | number | null;

export interface Store {
  all<T = Row>(sql: string, ...params: Param[]): T[];
  get<T = Row>(sql: string, ...params: Param[]): T | undefined;
  run(sql: string, ...params: Param[]): void;
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}

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
function retireLegacyPlatformAdmins(db: DatabaseSync): void {
  db.prepare("UPDATE users SET status = 'suspended' WHERE role = 'admin' AND status <> 'suspended'").run();
}

export function createStore(file = ':memory:'): Store {
  const db = new DatabaseSync(file);

  // SQLite applies DDL transactionally, and the migration must be all-or-
  // nothing. Without this, a statement that fails partway leaves the earlier
  // tables created — and because every statement is `IF NOT EXISTS`, the next
  // startup skips straight over them and the database stays permanently
  // half-built with no error to show for it.
  db.exec('BEGIN');
  try {
    db.exec(MIGRATION);
    addColumnIfMissing(db, 'audit_events', 'client_event_id', 'TEXT');
    addColumnIfMissing(db, 'refresh_tokens', 'device_label', 'TEXT');
    // Existing accounts inherit the defaults: they can read, see location and
    // see health, and nobody silently gains write.
    addColumnIfMissing(db, 'users', 'can_read', 'INTEGER NOT NULL DEFAULT 1');
    addColumnIfMissing(db, 'users', 'can_write', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'users', 'can_location', 'INTEGER NOT NULL DEFAULT 1');
    addColumnIfMissing(db, 'users', 'can_health', 'INTEGER NOT NULL DEFAULT 1');
    addColumnIfMissing(db, 'batteries', 'status', "TEXT NOT NULL DEFAULT 'active'");
    retireLegacyPlatformAdmins(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }

  return {
    all: <T = Row>(sql: string, ...params: Param[]) =>
      db.prepare(sql).all(...params) as T[],
    get: <T = Row>(sql: string, ...params: Param[]) =>
      db.prepare(sql).get(...params) as T | undefined,
    run: (sql: string, ...params: Param[]) => {
      db.prepare(sql).run(...params);
    },
    exec: (sql: string) => db.exec(sql),
    transaction: <T>(fn: () => T): T => {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => db.close(),
  };
}
