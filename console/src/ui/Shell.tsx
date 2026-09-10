import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../store/AuthProvider';

/**
 * The console's frame.
 *
 * Masthead and rail are leather and pinned; the content area is the cream panel
 * and is the only thing that scrolls. That is the app's rule, and keeping it
 * here is what makes the two read as one product rather than two.
 *
 * What appears in the rail depends on role, and that is presentation only: an
 * administrator sees platform-wide sections a company owner does not, but the
 * server refuses those routes regardless of what this renders. UI hiding is
 * never the security boundary (PRD §5.2).
 */

interface Section {
  to: string;
  label: string;
  /** Platform-wide, so only an administrator has anywhere to go with it. */
  adminOnly?: boolean;
}

const OPERATIONS: Section[] = [
  { to: '/batteries', label: 'Batteries' },
  { to: '/audit', label: 'Audit trail' },
  { to: '/support', label: 'Remote support' },
];

const ADMINISTRATION: Section[] = [
  { to: '/users', label: 'Users' },
  { to: '/devices', label: 'Devices' },
  { to: '/companies', label: 'Companies', adminOnly: true },
];

export function Shell() {
  const { user, company, signOut } = useAuth();
  const isAdmin = user?.role === 'admin';

  const visible = (sections: Section[]) => sections.filter((s) => !s.adminOnly || isAdmin);

  return (
    <div className="shell">
      <header className="masthead">
        <span className="wordmark">KnowyourEV</span>
        <span className="masthead-sub">
          {/* An administrator belongs to no company; saying so beats a blank. */}
          {company ? company.name : 'Platform administration'}
        </span>
        <div className="masthead-right">
          <span className="masthead-sub">{user?.displayName ?? user?.email}</span>
          <button type="button" className="secondary" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <nav className="rail" aria-label="Sections">
        <span className="rail-label">Operations</span>
        {visible(OPERATIONS).map((s) => (
          <NavLink key={s.to} to={s.to}>
            {s.label}
          </NavLink>
        ))}

        <span className="rail-label">Administration</span>
        {visible(ADMINISTRATION).map((s) => (
          <NavLink key={s.to} to={s.to}>
            {s.label}
          </NavLink>
        ))}
      </nav>

      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
