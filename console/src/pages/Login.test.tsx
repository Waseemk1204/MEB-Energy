import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../store/AuthProvider';
import { App } from '../App';

/**
 * Signing in to the console, driven the way a person would.
 */

const reply = (status: number, body: unknown = {}) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as Response;

const loginBody = (role: 'admin' | 'company' | 'user', company: unknown = null) => ({
  accessToken: 'a1',
  refreshToken: 'r1',
  user: { id: 'u1', email: 'ops@knowyourev.example', displayName: 'Ops Lead', role },
  company,
});

function mount(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;

  render(
    <MemoryRouter>
      <AuthProvider baseUrl="https://api.test" fetchImpl={fetchImpl}>
        <App />
      </AuthProvider>
    </MemoryRouter>
  );
  return { calls };
}

const signIn = async (email = 'ops@knowyourev.example', password = 'a-real-passphrase') => {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
};

beforeEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('the sign-in form', () => {
  it('is what an unauthenticated visitor gets, whatever the path', () => {
    mount(() => reply(200, {}));
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('will not submit until both fields are filled', async () => {
    mount(() => reply(200, {}));
    const button = screen.getByRole('button', { name: 'Sign in' });
    expect(button).toBeDisabled();

    await userEvent.setup().type(screen.getByLabelText('Email'), 'ops@knowyourev.example');
    expect(button).toBeDisabled();

    await userEvent.setup().type(screen.getByLabelText('Password'), 'x');
    expect(button).toBeEnabled();
  });

  it('sends the credentials to /auth/login', async () => {
    const { calls } = mount(() => reply(200, loginBody('admin')));
    await signIn();

    await waitFor(() => expect(calls[0]).toBeDefined());
    expect(calls[0]!.url).toBe('https://api.test/auth/login');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      email: 'ops@knowyourev.example',
      password: 'a-real-passphrase',
    });
  });

  it('trims the email so a stray space is not a failed sign-in', async () => {
    const { calls } = mount(() => reply(200, loginBody('admin')));
    await signIn('  ops@knowyourev.example  ');
    await waitFor(() => expect(calls[0]).toBeDefined());
    expect(JSON.parse(calls[0]!.init.body as string).email).toBe('ops@knowyourev.example');
  });
});

describe('what a failed sign-in says', () => {
  it('reads the same for a wrong password as for an unknown address', async () => {
    mount(() => reply(401, { error: 'unauthorized', message: 'Email or password is incorrect' }));
    await signIn();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Email or password is incorrect.');
    expect(alert).not.toHaveTextContent(/no account|not found|unknown/i);
  });

  it('names rate limiting, which the person can wait out', async () => {
    mount(() => reply(429, { error: 'rate_limited', message: 'slow down' }));
    await signIn();
    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many attempts/);
  });

  it('treats an unreachable server as unreachable, not as bad credentials', async () => {
    mount(() => {
      throw new TypeError('Failed to fetch');
    });
    await signIn();
    expect(await screen.findByRole('alert')).toHaveTextContent(/Cannot reach KnowyourEV/);
  });

  it('does not surface the server’s own wording', async () => {
    mount(() => reply(500, { error: 'boom', message: 'ECONNREFUSED at pool.ts:88' }));
    await signIn();
    expect(await screen.findByRole('alert')).not.toHaveTextContent(/ECONNREFUSED/);
  });

  it('leaves the visitor on the sign-in form', async () => {
    mount(() => reply(401, { error: 'unauthorized', message: 'no' }));
    await signIn();
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});

/**
 * A technician's credentials are valid; this is simply not their tool. They
 * are told so, rather than being dropped into a console of empty panels.
 */
describe('a technician signing in', () => {
  it('is turned away with an explanation', async () => {
    mount(() => reply(200, loginBody('user', { id: 'c1', name: 'Acme EV' })));
    await signIn();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/administrators and company owners/);
    expect(alert).toHaveTextContent(/KnowyourEV app/);
  });

  it('is not let into the console', async () => {
    mount(() => reply(200, loginBody('user')));
    await signIn();
    await screen.findByRole('alert');
    expect(screen.queryByRole('navigation', { name: 'Sections' })).not.toBeInTheDocument();
  });

  it('leaves no session behind for a reload to pick up', async () => {
    mount(() => reply(200, loginBody('user')));
    await signIn();
    await screen.findByRole('alert');
    expect(sessionStorage.getItem('knowyourev.console.session')).toBeNull();
  });
});

describe('a successful sign-in', () => {
  const handler = (url: string) =>
    url.endsWith('/auth/login')
      ? reply(200, loginBody('admin'))
      : reply(200, { batteries: [] });

  it('opens the console', async () => {
    mount(handler);
    await signIn();
    expect(await screen.findByRole('navigation', { name: 'Sections' })).toBeInTheDocument();
  });

  it('stores the session so a reload does not sign you out', async () => {
    mount(handler);
    await signIn();
    await screen.findByRole('navigation', { name: 'Sections' });

    const stored = JSON.parse(sessionStorage.getItem('knowyourev.console.session')!);
    expect(stored.user.role).toBe('admin');
    expect(stored.refreshToken).toBe('r1');
  });

  it('names the signed-in person', async () => {
    mount(handler);
    await signIn();
    expect(await screen.findByText('Ops Lead')).toBeInTheDocument();
  });

  it('says an administrator belongs to no company rather than showing a blank', async () => {
    mount(handler);
    await signIn();
    expect(await screen.findByText('Platform administration')).toBeInTheDocument();
  });

  it('names the company for a company owner', async () => {
    mount((url) =>
      url.endsWith('/auth/login')
        ? reply(200, loginBody('company', { id: 'c1', name: 'Acme EV' }))
        : reply(200, { batteries: [] })
    );
    await signIn();
    expect(await screen.findByText('Acme EV')).toBeInTheDocument();
  });
});

describe('signing out', () => {
  it('returns to the sign-in form and clears the session', async () => {
    mount((url) =>
      url.endsWith('/auth/login') ? reply(200, loginBody('admin')) : reply(200, { batteries: [] })
    );
    await signIn();
    await screen.findByRole('navigation', { name: 'Sections' });

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(sessionStorage.getItem('knowyourev.console.session')).toBeNull();
  });
});
