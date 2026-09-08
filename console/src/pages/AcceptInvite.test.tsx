import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../store/AuthProvider';
import { App } from '../App';
import { MIN_PASSWORD_LENGTH } from '../api/admin';

const reply = (status: number, body: unknown = {}) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as Response;

const accepted = {
  accessToken: 'a1',
  refreshToken: 'r1',
  user: { id: 'u9', email: 'new@acme.example', displayName: 'New Person', role: 'company' },
  company: { id: 'c1', name: 'Acme EV' },
};

function open(path: string, onAccept?: (body: unknown) => Response) {
  const sent: { url: string; body: unknown }[] = [];

  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    sent.push({ url, body });
    if (url.endsWith('/auth/accept-invite')) {
      return onAccept ? onAccept(body) : reply(200, accepted);
    }
    return reply(200, { batteries: [], users: [], devices: [], companies: [] });
  }) as unknown as typeof fetch;

  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider baseUrl="https://api.test" fetchImpl={fetchImpl}>
        <App />
      </AuthProvider>
    </MemoryRouter>
  );

  return { user: userEvent.setup(), sent };
}

const GOOD = 'my-own-first-passphrase';

const fill = async (
  user: ReturnType<typeof userEvent.setup>,
  { password = GOOD, confirm = GOOD } = {}
) => {
  await user.type(screen.getByLabelText(/New password/), password);
  await user.type(screen.getByLabelText('Repeat it'), confirm);
};

beforeEach(() => {
  sessionStorage.clear();
});

/**
 * This is the one screen a signed-out person is meant to reach, so it must not
 * sit behind the sign-in guard.
 */
describe('reaching the screen', () => {
  it('is shown without a session', () => {
    open('/accept-invite?token=inv-1');
    expect(screen.getByRole('button', { name: 'Set password and sign in' })).toBeInTheDocument();
  });

  it('is not the sign-in form', () => {
    open('/accept-invite?token=inv-1');
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('says so when the link has no invitation code', () => {
    open('/accept-invite');
    expect(screen.getByRole('alert')).toHaveTextContent(/missing its invitation code/);
  });

  it('offers no form without a code, since there is nothing to submit', () => {
    open('/accept-invite');
    expect(screen.queryByLabelText(/New password/)).not.toBeInTheDocument();
  });
});

describe('choosing a password', () => {
  it('will not submit one that is too short', async () => {
    const { user } = open('/accept-invite?token=inv-1');
    const short = 'x'.repeat(MIN_PASSWORD_LENGTH - 1);
    await fill(user, { password: short, confirm: short });
    expect(screen.getByRole('button', { name: 'Set password and sign in' })).toBeDisabled();
  });

  it('will not submit when the two do not match', async () => {
    const { user } = open('/accept-invite?token=inv-1');
    await fill(user, { confirm: 'a-different-passphrase' });
    expect(screen.getByRole('button', { name: 'Set password and sign in' })).toBeDisabled();
  });

  it('says they do not match, once there is something to say it about', async () => {
    const { user } = open('/accept-invite?token=inv-1');
    await user.type(screen.getByLabelText(/New password/), GOOD);
    // Nothing typed in the second field yet — no complaint.
    expect(screen.queryByText('These do not match.')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Repeat it'), 'x');
    expect(screen.getByText('These do not match.')).toBeInTheDocument();
  });

  it('stops complaining once they do match', async () => {
    const { user } = open('/accept-invite?token=inv-1');
    await fill(user);
    expect(screen.queryByText('These do not match.')).not.toBeInTheDocument();
  });

  it('sends the token and the chosen password', async () => {
    const { user, sent } = open('/accept-invite?token=inv-1');
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Set password and sign in' }));

    await waitFor(() => expect(sent.some((s) => s.url.endsWith('/auth/accept-invite'))).toBe(true));
    expect(sent.find((s) => s.url.endsWith('/auth/accept-invite'))!.body).toEqual({
      token: 'inv-1',
      password: GOOD,
    });
  });
});

describe('after accepting', () => {
  it('opens the console without a second sign-in', async () => {
    const { user } = open('/accept-invite?token=inv-1');
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Set password and sign in' }));

    expect(await screen.findByRole('navigation', { name: 'Sections' })).toBeInTheDocument();
  });

  it('stores the session', async () => {
    const { user } = open('/accept-invite?token=inv-1');
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Set password and sign in' }));

    await screen.findByRole('navigation', { name: 'Sections' });
    const stored = JSON.parse(sessionStorage.getItem('knowyourev.console.session')!);
    expect(stored.user.email).toBe('new@acme.example');
    expect(stored.company.name).toBe('Acme EV');
  });

  /**
   * A technician's invitation is valid and their password is now set — the
   * link has been spent either way. The console is still not their tool, and
   * saying so beats dropping them into a set of screens they cannot use.
   */
  it('does not open the console for a technician', async () => {
    const { user } = open('/accept-invite?token=inv-1', () =>
      reply(200, { ...accepted, user: { ...accepted.user, role: 'user' } })
    );
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Set password and sign in' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Your password is set/);
    expect(alert).toHaveTextContent(/knowyourEV app/);
    expect(screen.queryByRole('navigation', { name: 'Sections' })).not.toBeInTheDocument();
  });

  it('leaves no console session behind for a technician', async () => {
    const { user } = open('/accept-invite?token=inv-1', () =>
      reply(200, { ...accepted, user: { ...accepted.user, role: 'user' } })
    );
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Set password and sign in' }));

    await screen.findByRole('alert');
    expect(sessionStorage.getItem('knowyourev.console.session')).toBeNull();
  });
});

describe('when the link does not work', () => {
  it('shows the server’s wording for a spent or unknown link', async () => {
    const { user } = open('/accept-invite?token=inv-1', () =>
      reply(400, {
        error: 'bad_request',
        message: 'That invitation is not valid or has already been used',
      })
    );
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Set password and sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That invitation is not valid or has already been used'
    );
  });

  it('says nothing about why it failed', async () => {
    const { user } = open('/accept-invite?token=inv-1', () =>
      reply(400, {
        error: 'bad_request',
        message: 'That invitation is not valid or has already been used',
      })
    );
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Set password and sign in' }));

    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent(/expired|not found|already accepted by/i);
  });

  it('treats an unreachable server as unreachable', async () => {
    const { user } = open('/accept-invite?token=inv-1', () => {
      throw new TypeError('Failed to fetch');
    });
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Set password and sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Cannot reach knowyourEV/);
  });

  it('leaves the form usable for another attempt', async () => {
    const { user } = open('/accept-invite?token=inv-1', () =>
      reply(400, { error: 'bad_request', message: 'nope' })
    );
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Set password and sign in' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Set password and sign in' })).toBeEnabled();
  });
});

describe('what the screen promises', () => {
  it('says the link works once and the password stays private', () => {
    open('/accept-invite?token=inv-1');
    const foot = screen.getByText(/This link works once/);
    expect(foot).toHaveTextContent(/Nobody else, including whoever invited you/);
  });
});
