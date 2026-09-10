import { useState, type FormEvent } from 'react';
import { useAuth } from '../store/AuthProvider';

/**
 * Full-bleed leather, no cream panel — the same treatment the app gives its
 * own sign-in. Nothing here is data; it is all instrument.
 */
export function Login() {
  const { signIn, signingIn, error } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const ready = email.trim().length > 3 && password.length > 0 && !signingIn;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    void signIn(email, password);
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={onSubmit}>
        <span className="wordmark">KnowyourEV</span>
        <p className="login-sub">Administration console</p>

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {/*
          The wording comes from the provider, which says the same thing for a
          wrong password as for an unknown address.
        */}
        {error ? (
          <p role="alert" className="notice notice-error">
            {error}
          </p>
        ) : null}

        <button type="submit" disabled={!ready}>
          {signingIn ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="login-foot">
          Field work happens in the KnowyourEV app. This console is for administrators and
          company owners.
        </p>
      </form>
    </div>
  );
}
