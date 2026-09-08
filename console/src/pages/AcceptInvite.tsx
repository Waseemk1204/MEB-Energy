import { useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../store/AuthProvider';
import { MIN_PASSWORD_LENGTH } from '../api/admin';

/**
 * Setting your own first password.
 *
 * Reached by a single-use link, with no account and no session. It is the one
 * screen in the console that a signed-out person is meant to see, so it is
 * routed before the sign-in guard rather than behind it.
 */
export function AcceptInvite() {
  const { acceptInvite, user } = useAuth();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const longEnough = password.length >= MIN_PASSWORD_LENGTH;
  const matches = confirm.length > 0 && password === confirm;
  const ready = longEnough && matches && !busy && token !== '';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;

    setBusy(true);
    setError(null);
    const failure = await acceptInvite(token, password);
    if (failure) setError(failure);
    setBusy(false);
  };

  // Accepting signs the person in, so there is nothing left to do here.
  // Leaving them on this screen would look as though it had not worked.
  if (user) return <Navigate to="/batteries" replace />;

  if (!token) {
    return (
      <div className="login">
        <div className="login-card">
          <span className="wordmark">knowyourEV</span>
          <p className="login-sub">Invitation</p>
          <p role="alert" className="notice notice-error">
            This link is missing its invitation code. Ask whoever invited you to send it again.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <span className="wordmark">knowyourEV</span>
        <p className="login-sub">Choose your password</p>

        <div className="field">
          <label htmlFor="password">
            New password (at least {MIN_PASSWORD_LENGTH} characters)
          </label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="confirm">Repeat it</label>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {/*
            Only complain once there is something to complain about — telling
            someone their password does not match before they have finished
            typing it is noise.
          */}
          {confirm.length > 0 && !matches ? (
            <p className="notice notice-warn" style={{ marginTop: 8 }}>
              These do not match.
            </p>
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="notice notice-error">
            {error}
          </p>
        ) : null}

        <button type="submit" disabled={!ready}>
          {busy ? 'Setting…' : 'Set password and sign in'}
        </button>

        <p className="login-foot">
          This link works once. Nobody else, including whoever invited you, will know the password
          you choose.
        </p>
      </form>
    </div>
  );
}
