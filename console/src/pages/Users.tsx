import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../store/AuthProvider';
import {
  USER_STATUS_LABEL,
  USER_STATUS_TONE,
  inviteUser,
  invitationLink,
  listCompanies,
  listUsers,
  seatUsage,
  setUserStatus,
  type Company,
  type Role,
  type SeatUsage,
  type User,
} from '../api/admin';

/**
 * The people who can sign in.
 *
 * Two things are stated rather than implied: suspending an account signs that
 * person out immediately, and an invitation link is the account until it is
 * accepted — whoever holds it can claim it. Neither is hidden behind a
 * confirmation dialog that says "Are you sure?" and nothing else.
 */
export function Users() {
  const { api, user: me, company } = useAuth();
  const isAdmin = me?.role === 'admin';

  const [users, setUsers] = useState<User[] | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [seats, setSeats] = useState<SeatUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Shown once. The server stores the token hashed and cannot produce it
  // again, so this is genuinely the only opportunity to copy it.
  const [issued, setIssued] = useState<{ email: string; link: string; expiresAt: number } | null>(
    null
  );

  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [companyId, setCompanyId] = useState(company?.id ?? '');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setUsers(await listUsers(api));
      if (isAdmin) setCompanies(await listCompanies(api));

      // Seats are a per-company limit. An administrator belongs to no company
      // and sees users across all of them, so a single seat count would be
      // meaningless — there is deliberately no number for them.
      if (company?.id) setSeats(await seatUsage(api, company.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load users');
    }
  }, [api, isAdmin, company?.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      // No password is sent. The account is unusable until the person accepts.
      const created = await inviteUser(api, {
        companyId: role === 'admin' ? null : companyId || null,
        email: email.trim(),
        displayName: displayName.trim(),
        role,
      });

      if (!created.invitation) {
        setError('The server created that account without an invitation. Nothing to hand over.');
        return;
      }

      setIssued({
        email: email.trim(),
        link: invitationLink(created.invitation.token),
        expiresAt: created.invitation.expiresAt,
      });
      setEmail('');
      setDisplayName('');
      setShowForm(false);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create that user');
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (target: User, next: 'active' | 'suspended') => {
    setError(null);
    setNotice(null);
    try {
      await setUserStatus(api, target.id, next);
      setNotice(
        next === 'suspended'
          ? target.status === 'invited'
            ? `The invitation for ${target.email} is cancelled. The link no longer works.`
            : `${target.email} is suspended and has been signed out everywhere.`
          : `${target.email} can sign in again.`
      );
      await load();
    } catch (caught) {
      // The server refuses to suspend the last administrator, and its wording
      // explains why better than anything this screen could invent.
      setError(caught instanceof Error ? caught.message : 'Could not change that account');
    }
  };

  return (
    <>
      <h1 className="page-title">Users</h1>
      <p className="page-sub">
        {isAdmin
          ? 'Everyone on the platform, across every company.'
          : 'The people in your company who can sign in.'}
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

      {issued ? (
        <div className="panel">
          <h2 className="panel-title">Invitation link for {issued.email}</h2>
          <p className="panel-note">
            Shown once — the server keeps only a hash of it and cannot produce it again. It works
            a single time and expires{' '}
            {new Date(issued.expiresAt).toISOString().slice(0, 10)}.
          </p>
          <p className="notice notice-warn">
            Until they use it, whoever holds this link can claim the account. Send it over
            something private, not a shared channel.
          </p>
          <p className="figure" style={{ wordBreak: 'break-all' }}>{issued.link}</p>
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(issued.link).catch(() => undefined)}
          >
            Copy link
          </button>{' '}
          <button type="button" className="secondary" onClick={() => setIssued(null)}>
            I have sent it
          </button>
        </div>
      ) : null}

      {seats ? (
        <p className="panel-note">
          {seats.limit === null
            ? `${seats.used} active users. No seat limit on this plan.`
            : `${seats.used} of ${seats.limit} seats used. Suspending an account frees its seat.`}
        </p>
      ) : null}

      {!showForm ? (
        <p style={{ marginBottom: 16 }}>
          <button type="button" onClick={() => setShowForm(true)}>
            Add a user
          </button>
        </p>
      ) : (
        <form className="panel" onSubmit={submit}>
          <h2 className="panel-title">Add a user</h2>
          <p className="panel-note">
            They set their own password. This creates an account that cannot be signed into and
            gives you a single-use link to send them — there is no invitation email yet, so you
            have to hand it over yourself.
          </p>

          <div className="field">
            <label htmlFor="displayName">Name</label>
            <input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>

          <div className="field">
            <label htmlFor="role">Role</label>
            <select id="role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="user">Technician — the app, in the field</option>
              <option value="company">Company owner — this console, one company</option>
              {isAdmin ? <option value="admin">Administrator — the whole platform</option> : null}
            </select>
          </div>

          {isAdmin && role !== 'admin' ? (
            <div className="field">
              <label htmlFor="company">Company</label>
              <select id="company" value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                <option value="">Select a company…</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {role === 'admin' ? (
            <p className="notice notice-warn">
              An administrator belongs to no company and can see and change every tenant.
            </p>
          ) : null}

          <button
            type="submit"
            disabled={
              busy ||
              email.trim().length < 4 ||
              displayName.trim().length === 0 ||
              (role !== 'admin' && !companyId)
            }
          >
            {busy ? 'Creating…' : 'Create user'}
          </button>{' '}
          <button type="button" className="secondary" onClick={() => setShowForm(false)}>
            Cancel
          </button>
        </form>
      )}

      <div className="panel">
        {users === null && !error ? (
          <p className="empty">Loading…</p>
        ) : users && users.length === 0 ? (
          <p className="empty">Nobody has been added yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Access</th>
              </tr>
            </thead>
            <tbody>
              {(users ?? []).map((u) => (
                <tr key={u.id}>
                  <td>{u.displayName}</td>
                  <td className="figure">{u.email}</td>
                  <td>{ROLE_LABEL[u.role]}</td>
                  <td>
                    <span className={`chip chip-${USER_STATUS_TONE[u.status]}`}>
                      {USER_STATUS_LABEL[u.status]}
                    </span>
                  </td>
                  <td>
                    {u.id === me?.id ? (
                      <span style={{ color: 'var(--ink-faint)' }}>This is you</span>
                    ) : u.status === 'invited' ? (
                      // Restoring is meaningless — there is no password yet.
                      // Suspending is how an invitation is cancelled.
                      <button
                        type="button"
                        className="danger"
                        onClick={() => void changeStatus(u, 'suspended')}
                        title="Cancels the invitation"
                      >
                        Cancel invitation
                      </button>
                    ) : u.status === 'active' ? (
                      <button
                        type="button"
                        className="danger"
                        onClick={() => void changeStatus(u, 'suspended')}
                        title="Signs them out everywhere, immediately"
                      >
                        Suspend
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => void changeStatus(u, 'active')}
                      >
                        Restore
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

const ROLE_LABEL: Record<Role, string> = {
  admin: 'Administrator',
  company: 'Company owner',
  user: 'Technician',
};
