import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../store/AuthProvider';
import {
  DEFAULT_DEVICE_LIMIT,
  DEFAULT_SESSION_DEVICES,
  ENTITLEMENT_LABEL,
  ENTITLEMENT_TONE,
  SEAT_TIERS,
  adjustLimits,
  createCompany,
  describeRemaining,
  getEntitlement,
  grantAccess,
  listCompanies,
  revokeAccess,
  type Company,
  type Entitlement,
} from '../api/admin';

/**
 * Tenants. Administrators only — a company owner has no business seeing the
 * other companies on the platform, and the server refuses them this listing
 * with a 404 rather than a 403, so it does not even confirm the route exists.
 */
export function Companies() {
  const { api } = useAuth();
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /** One entitlement per company, loaded alongside the listing. */
  const [access, setAccess] = useState<Record<string, Entitlement>>({});
  /** The company currently being changed, so only its own buttons disable. */
  const [changing, setChanging] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [seatLimit, setSeatLimit] = useState('10');
  const [batteryLimit, setBatteryLimit] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const rows = await listCompanies(api);
      setCompanies(rows);

      // Each company's own entitlement. Fetched per row rather than folded
      // into the listing, so a company that cannot be read does not blank the
      // whole page.
      const entries = await Promise.all(
        rows.map(async (c) => [c.id, await getEntitlement(api, c.id).catch(() => null)] as const)
      );
      setAccess(
        Object.fromEntries(entries.filter((e): e is [string, Entitlement] => e[1] !== null))
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load companies');
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createCompany(api, {
        name: name.trim(),
        seatLimit: Number(seatLimit),
        // Blank means no limit, which is a different thing from zero.
        batteryLimit: batteryLimit === '' ? null : Number(batteryLimit),
      });
      setNotice(`${name.trim()} created. It has no users yet — add one before anyone can sign in.`);
      setName('');
      setShowForm(false);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create that company');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Granting and adjusting are the same conversation — how many users, how
   * many gateways, how many devices the owner may be signed in on — so they
   * are the same prompt. The difference is that granting starts a fresh year
   * and adjusting does not, which is said out loud rather than left to be
   * discovered.
   *
   * Cancelling any question abandons the whole change rather than applying
   * half of it.
   */
  const onGrant = async (company: Company) => {
    const current = access[company.id];
    const renewing = current?.ok === true;

    /** Returns null for "cancelled" and undefined for "not a usable number". */
    const ask = (question: string, fallback: number): number | null | undefined => {
      const answer = window.prompt(question, String(fallback));
      if (answer === null) return null;
      const value = Number(answer);
      return Number.isInteger(value) && value >= 1 ? value : undefined;
    };

    const seatLimitValue = ask(
      `Users for ${company.name} — suggested tiers: ${SEAT_TIERS.join(', ')}`,
      current?.seatLimit ?? 20
    );
    if (seatLimitValue === null) return;
    if (seatLimitValue === undefined) {
      setError('The number of users must be a whole number of at least 1.');
      return;
    }

    const deviceLimitValue = ask(
      `KnowyourEV gateways ${company.name} may register (default ${DEFAULT_DEVICE_LIMIT})`,
      current?.deviceLimit ?? DEFAULT_DEVICE_LIMIT
    );
    if (deviceLimitValue === null) return;
    if (deviceLimitValue === undefined) {
      setError('The number of gateways must be a whole number of at least 1.');
      return;
    }

    /*
     * A different thing from the gateways above, and asked separately because
     * calling both "devices" is exactly how the two get confused. This one
     * caps the phones and browsers the company-owner login may be signed in
     * on at once — the shared-password limit.
     */
    const sessionDeviceValue = ask(
      `Phones and browsers the ${company.name} owner account may be signed in on ` +
        `at once (default ${DEFAULT_SESSION_DEVICES})`,
      current?.sessionDeviceLimit ?? DEFAULT_SESSION_DEVICES
    );
    if (sessionDeviceValue === null) return;
    if (sessionDeviceValue === undefined) {
      setError('The number of sign-in devices must be a whole number of at least 1.');
      return;
    }

    setChanging(company.id);
    setError(null);
    try {
      if (renewing) {
        // Adjusting a live plan. Starting a new year here would forfeit
        // whatever the company has already paid for.
        await adjustLimits(api, company.id, {
          seatLimit: seatLimitValue,
          deviceLimit: deviceLimitValue,
          sessionDeviceLimit: sessionDeviceValue,
        });
        setNotice(`${company.name} updated. Its existing term is unchanged.`);
      } else {
        const granted = await grantAccess(api, company.id, {
          seatLimit: seatLimitValue,
          deviceLimit: deviceLimitValue,
          sessionDeviceLimit: sessionDeviceValue,
        });
        setNotice(
          `${company.name} has access for a year, until ` +
            `${new Date(granted.expiresAt).toISOString().slice(0, 10)}.`
        );
      }
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not change that company');
    } finally {
      setChanging(null);
    }
  };

  const onRevoke = async (company: Company) => {
    if (
      !window.confirm(
        `Revoke access for ${company.name}? Everybody there is signed out and cannot sign back in.`
      )
    ) {
      return;
    }

    setChanging(company.id);
    setError(null);
    try {
      await revokeAccess(api, company.id);
      setNotice(`${company.name} can no longer be used. Grant access again to restore it.`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not revoke that company');
    } finally {
      setChanging(null);
    }
  };

  const seats = Number(seatLimit);
  const valid = name.trim().length > 0 && Number.isInteger(seats) && seats >= 1;

  return (
    <>
      <h1 className="page-title">Companies</h1>
      <p className="page-sub">
        Tenants on the platform. Payment happens outside KnowyourEV — granting access here is how
        it becomes usable, for a year from the moment you grant it.
      </p>

      {error ? (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="notice notice-info">
          {notice}
        </p>
      ) : null}

      {!showForm ? (
        <p style={{ marginBottom: 16 }}>
          <button type="button" onClick={() => setShowForm(true)}>
            Add a company
          </button>
        </p>
      ) : (
        <form className="panel" onSubmit={submit}>
          <h2 className="panel-title">Add a company</h2>
          <p className="panel-note">
            A yearly subscription is created alongside it. Limits can be raised later; leaving one
            blank means no limit, which is not the same as zero.
          </p>

          <div className="field">
            <label htmlFor="name">Name</label>
            <input id="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="field">
            <label htmlFor="seatLimit">Seat limit (users who can be active at once)</label>
            <input
              id="seatLimit"
              type="number"
              min={1}
              value={seatLimit}
              onChange={(e) => setSeatLimit(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="batteryLimit">Battery limit (blank for no limit)</label>
            <input
              id="batteryLimit"
              type="number"
              min={1}
              value={batteryLimit}
              onChange={(e) => setBatteryLimit(e.target.value)}
            />
          </div>

          <button type="submit" disabled={busy || !valid}>
            {busy ? 'Creating…' : 'Create company'}
          </button>{' '}
          <button type="button" className="secondary" onClick={() => setShowForm(false)}>
            Cancel
          </button>
        </form>
      )}

      <div className="panel">
        {companies === null && !error ? (
          <p className="empty">Loading…</p>
        ) : companies && companies.length === 0 ? (
          <p className="empty">No companies yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Access</th>
                <th scope="col">Term</th>
                <th scope="col">Users</th>
                {/* Gateways, then the owner's signed-in phones and browsers.
                    Two different things, so two columns and two names. */}
                <th scope="col">Gateways</th>
                <th scope="col">Sign-ins</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(companies ?? []).map((c) => {
                const e = access[c.id];
                const usage = (u: { used: number; limit: number | null } | undefined) =>
                  !u ? '—' : u.limit === null ? `${u.used} · no limit` : `${u.used} of ${u.limit}`;

                return (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>
                      {e ? (
                        <span className={`chip chip-${ENTITLEMENT_TONE[e.code]}`}>
                          {ENTITLEMENT_LABEL[e.code]}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--ink-faint)' }}>Unknown</span>
                      )}
                    </td>
                    <td className="figure">
                      {/* A date with no sense of urgency is easy to miss. */}
                      {e?.expiresAt ? describeRemaining(e.expiresAt) : '—'}
                    </td>
                    <td className="figure">{usage(e?.seats)}</td>
                    <td className="figure">{usage(e?.devices)}</td>
                    <td className="figure">{usage(e?.sessionDevices)}</td>
                    <td>
                      <button
                        type="button"
                        className="secondary"
                        disabled={changing === c.id}
                        onClick={() => void onGrant(c)}
                      >
                        {e?.ok ? 'Renew or change' : 'Grant access'}
                      </button>{' '}
                      {e?.ok ? (
                        <button
                          type="button"
                          className="danger"
                          disabled={changing === c.id}
                          onClick={() => void onRevoke(c)}
                        >
                          Revoke
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
