import type { Param } from './client.js';

/**
 * Tenant scoping you cannot forget.
 *
 * Tenant data is only reachable through {@link tenantQuery}, which always emits
 * the company clause. The platform-wide escape hatch exists — an Admin needs it
 * — but it is separately named, so any cross-tenant query is visible as such in
 * a diff and findable with a grep.
 *
 * PRD §5.2: permissions are enforced server-side. UI hiding is never the
 * boundary, and neither is a developer remembering to add a WHERE clause.
 */

export type Role = 'admin' | 'company' | 'user';

export interface Principal {
  userId: string;
  role: Role;
  /** Null only for platform admins. */
  companyId: string | null;
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
  'subscriptions',
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
 * Builds a SELECT that is scoped to the principal's tenant.
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

  let sql = `SELECT ${columns} FROM ${table}`;

  if (principal.role === 'admin') {
    // Deliberately unscoped. Reached only through an admin principal, and the
    // caller had to pass one to get here.
    if (extra) sql += ` WHERE ${extra}`;
  } else {
    if (!principal.companyId) {
      throw new TenantScopeError(
        `Principal ${principal.userId} has role '${principal.role}' but no company`
      );
    }
    sql += ` WHERE ${table}.company_id = ?`;
    params.push(principal.companyId);
    if (extra) sql += ` AND (${extra})`;
  }

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
 * Explicitly cross-tenant. Only an admin may use it, and the name is meant to
 * stand out in review.
 */
export function platformWide(principal: Principal): void {
  if (principal.role !== 'admin') {
    throw new TenantScopeError(
      `Role '${principal.role}' cannot query platform-wide; scope the query to a company`
    );
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
  if (principal.role === 'admin') return;
  if (row.company_id !== principal.companyId) {
    // Deliberately identical to the not-found message: telling a caller that a
    // resource exists but belongs to someone else is itself a disclosure.
    throw new TenantScopeError(`${what} not found`);
  }
}

/** Can this principal manage users in the given company? */
export function canManageUsers(principal: Principal, companyId: string): boolean {
  if (principal.role === 'admin') return true;
  if (principal.role === 'company') return principal.companyId === companyId;
  return false;
}

/** Can this principal write BMS parameters on batteries in the given company? */
export function canWriteParameters(principal: Principal, companyId: string): boolean {
  if (principal.role === 'admin') return true;
  return principal.companyId === companyId;
}
