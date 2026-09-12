import type { Param } from './client.js';

/**
 * Tenant scoping you cannot forget.
 *
 * Every row of operational data carries a `company_id`, and every query that
 * reads it goes through {@link tenantQuery}, which always emits the company
 * clause. The application serves one company, so in practice every row
 * belongs to it — but the clause stays, because the day a second database is
 * merged in or a stale row survives, a query that forgot its scope is the
 * kind of bug nobody notices until somebody else's battery appears in a list.
 *
 * PRD §5.2: permissions are enforced server-side. UI hiding is never the
 * boundary, and neither is a developer remembering to add a WHERE clause.
 */

/**
 * Who somebody is inside the company.
 *
 * `company` is the company's administrator: they look after the fleet and the
 * people, open remote-support sessions and hold every permission implicitly.
 * `user` is a technician, whose permissions the administrator sets.
 */
export type Role = 'company' | 'user';

export const ROLES: readonly Role[] = ['company', 'user'];

export const isRole = (value: unknown): value is Role =>
  typeof value === 'string' && (ROLES as readonly string[]).includes(value);

export interface Principal {
  userId: string;
  role: Role;
  /** Every principal belongs to the company. */
  companyId: string;
}

export class TenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopeError';
  }
}

/** Tables that carry `company_id` and must always be scoped. */
export const TENANT_TABLES = [
  'batteries',
  'devices',
  'audit_events',
  'users',
  'ble_sessions',
  'telemetry_readings',
  'commands',
  'support_sessions',
] as const;
export type TenantTable = (typeof TENANT_TABLES)[number];

export interface ScopedQuery {
  sql: string;
  params: Param[];
}

/**
 * Builds a SELECT that is scoped to the principal's company.
 *
 * `columns` and `table` are interpolated because they are code, never input;
 * every value goes through a bound parameter. Extra conditions are appended
 * after the company clause, so adding one cannot displace it.
 */
export function tenantQuery(
  principal: Principal,
  table: TenantTable,
  options: { columns?: string; where?: string; params?: Param[]; orderBy?: string } = {}
): ScopedQuery {
  assertKnownTable(table);
  const columns = options.columns ?? '*';
  const extra = options.where;
  const params: Param[] = [];

  if (!principal.companyId) {
    throw new TenantScopeError(`Principal ${principal.userId} has no company`);
  }

  let sql = `SELECT ${columns} FROM ${table} WHERE ${table}.company_id = ?`;
  params.push(principal.companyId);
  if (extra) sql += ` AND (${extra})`;

  if (options.params) params.push(...options.params);
  if (options.orderBy) sql += ` ORDER BY ${options.orderBy}`;

  return { sql, params };
}

function assertKnownTable(table: string): asserts table is TenantTable {
  if (!(TENANT_TABLES as readonly string[]).includes(table)) {
    throw new TenantScopeError(`'${table}' is not a tenant-scoped table`);
  }
}

/**
 * Guards a row fetched by primary key. An id lookup carries no company clause,
 * so ownership is checked after the fact — this is the ID-guessing attack the
 * PRD's build plan calls out, and the check belongs in exactly one place.
 */
export function assertOwned(
  principal: Principal,
  row: { company_id: string } | undefined | null,
  what: string
): asserts row is { company_id: string } {
  if (!row) throw new TenantScopeError(`${what} not found`);
  if (row.company_id !== principal.companyId) {
    // Deliberately identical to the not-found message: telling a caller that a
    // resource exists but belongs to someone else is itself a disclosure.
    throw new TenantScopeError(`${what} not found`);
  }
}

/** Can this principal manage users, packs and gateways in the given company? */
export function canManageUsers(principal: Principal, companyId: string): boolean {
  return principal.role === 'company' && principal.companyId === companyId;
}

/** Can this principal write BMS parameters on batteries in the given company? */
export function canWriteParameters(principal: Principal, companyId: string): boolean {
  return principal.companyId === companyId;
}
