import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../store/AuthProvider';
import { App } from '../App';
import { invitationLink, userFromRow, type Role } from '../api/admin';

const reply = (status: number, body: unknown = {}) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as Response;

const row = (over: Record<string, unknown> = {}) => ({
  id: 'u2',
  company_id: 'c1',
  email: 'tech@acme.example',
  display_name: 'W Khan',
  role: 'user' as Role,
  status: 'active' as const,
  ...over,
});

interface Options {
  role?: Role;
  users?: unknown[];
  onCreate?: (body: unknown) => Response;
  onStatus?: (body: unknown) => Response;
  seats?: { used: number; limit: number | null };
}

async function openUsers(options: Options = {}) {
  const sent: { url: string; method: string; body: unknown }[] = [];

  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    sent.push({ url, method: init.method ?? 'GET', body });

    if (url.endsWith('/auth/login')) {
      return reply(200, {
        accessToken: 'a1',
        refreshToken: 'r1',
        user: {
          id: 'u1',
          email: 'ops@knowyourev.example',
          displayName: 'Ops',
          role: options.role ?? 'admin',
        },
        company: options.role === 'company' ? { id: 'c1', name: 'Acme EV' } : null,
      });
    }
    if (url.endsWith('/users') && init.method === 'POST') {
      return options.onCreate
        ? options.onCreate(body)
        : reply(201, {
            id: 'u9',
            email: 'new@acme.example',
            role: 'user',
            status: 'invited',
            invitation: { token: 'inv-token-1', expiresAt: Date.now() + 7 * 24 * 3600_000 },
          });
    }
    if (url.endsWith('/users')) return reply(200, { users: options.users ?? [row()] });
    if (url.includes('/status')) {
      return options.onStatus ? options.onStatus(body) : reply(204);
    }
    if (url.includes('/seats')) return reply(200, options.seats ?? { used: 1, limit: 10 });
    if (url.endsWith('/companies')) {
      return reply(200, { companies: [{ id: 'c1', name: 'Acme EV', status: 'active', created_at: 0 }] });
    }
    return reply(200, {});
  }) as unknown as typeof fetch;

  render(
    <MemoryRouter initialEntries={['/users']}>
      <AuthProvider baseUrl="https://api.test" fetchImpl={fetchImpl}>
        <App />
      </AuthProvider>
    </MemoryRouter>
  );

  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Email'), 'ops@knowyourev.example');
  await user.type(screen.getByLabelText('Password'), 'a-real-passphrase');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { name: 'Users' });

  return { user, sent };
}

const rowFor = async (email: string) => (await screen.findByText(email)).closest('tr')!;

beforeEach(() => {
  sessionStorage.clear();
});

describe('the invitation link', () => {
  it('points at the accept-invite screen with the token', () => {
    expect(invitationLink('abc123', 'https://console.example')).toBe(
      'https://console.example/accept-invite?token=abc123'
    );
  });

  it('escapes a token containing URL characters', () => {
    expect(invitationLink('a+b/c=', 'https://console.example')).toBe(
      'https://console.example/accept-invite?token=a%2Bb%2Fc%3D'
    );
  });
});

describe('reading a user row', () => {
  it('maps the wire shape', () => {
    expect(userFromRow(row())).toEqual({
      id: 'u2',
      companyId: 'c1',
      email: 'tech@acme.example',
      displayName: 'W Khan',
      role: 'user',
      status: 'active',
    });
  });
});

describe('the list', () => {
  it('names each person, their role and their status', async () => {
    await openUsers();
    const tr = await rowFor('tech@acme.example');
    expect(within(tr).getByText('W Khan')).toBeInTheDocument();
    expect(within(tr).getByText('Technician')).toBeInTheDocument();
    expect(within(tr).getByText('Active')).toBeInTheDocument();
  });

  it('reports seat usage to a company owner, and that suspension frees a seat', async () => {
    await openUsers({ role: 'company', seats: { used: 7, limit: 10 } });
    expect(await screen.findByText(/7 of 10 seats used/)).toBeInTheDocument();
    expect(screen.getByText(/frees its seat/)).toBeInTheDocument();
  });

  /**
   * Seats are a per-company limit. An administrator belongs to no company and
   * sees users across all of them, so one number would be meaningless.
   */
  it('shows no seat count to an administrator', async () => {
    await openUsers({ role: 'admin', seats: { used: 7, limit: 10 } });
    await screen.findByText('tech@acme.example');
    expect(screen.queryByText(/seats used/)).not.toBeInTheDocument();
  });

  it('says so when a plan has no seat limit, rather than showing a number', async () => {
    await openUsers({ role: 'company', seats: { used: 3, limit: null } });
    expect(await screen.findByText(/No seat limit on this plan/)).toBeInTheDocument();
  });

  /** Suspending yourself is a way to lock yourself out; it is not offered. */
  it('offers no action against your own account', async () => {
    await openUsers({
      users: [row({ id: 'u1', email: 'ops@knowyourev.example', display_name: 'Ops', role: 'admin' })],
    });
    const tr = await rowFor('ops@knowyourev.example');
    expect(within(tr).getByText('This is you')).toBeInTheDocument();
    expect(within(tr).queryByRole('button')).not.toBeInTheDocument();
  });
});

/**
 * Suspension revokes every refresh token the account holds, so it takes effect
 * immediately rather than whenever a token happens to expire. Saying so is the
 * difference between an informed action and a surprising one.
 */
describe('suspending someone', () => {
  it('says it signs them out everywhere', async () => {
    const { user } = await openUsers();
    await user.click(within(await rowFor('tech@acme.example')).getByRole('button', { name: 'Suspend' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('signed out everywhere');
  });

  it('sends the status change', async () => {
    const { user, sent } = await openUsers();
    await user.click(within(await rowFor('tech@acme.example')).getByRole('button', { name: 'Suspend' }));

    await waitFor(() => expect(sent.some((s) => s.url.includes('/status'))).toBe(true));
    const call = sent.find((s) => s.url.includes('/status'))!;
    expect(call.method).toBe('PATCH');
    expect(call.body).toEqual({ status: 'suspended' });
  });

  it('offers to restore a suspended account instead', async () => {
    await openUsers({ users: [row({ status: 'suspended' })] });
    const tr = await rowFor('tech@acme.example');
    expect(within(tr).getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(within(tr).queryByRole('button', { name: 'Suspend' })).not.toBeInTheDocument();
  });

  /**
   * The backend refuses to suspend the last active administrator, because
   * nothing in the product can recover from that. Its wording explains it
   * better than this screen could.
   */
  it('surfaces the server’s refusal rather than inventing one', async () => {
    const { user } = await openUsers({
      users: [row({ id: 'u5', email: 'other@knowyourev.example', role: 'admin', company_id: null })],
      onStatus: () =>
        reply(409, {
          error: 'last_admin',
          message: 'Cannot suspend the last active administrator',
        }),
    });
    await user.click(within(await rowFor('other@knowyourev.example')).getByRole('button', { name: 'Suspend' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cannot suspend the last active administrator'
    );
  });
});

describe('adding a user', () => {
  const openForm = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: 'Add a user' }));
    await user.type(screen.getByLabelText('Name'), 'New Person');
    await user.type(screen.getByLabelText('Email'), 'new@acme.example');
  };

  it('says the new person sets their own password', async () => {
    const { user } = await openUsers();
    await user.click(screen.getByRole('button', { name: 'Add a user' }));
    expect(screen.getByText(/They set their own password/)).toBeInTheDocument();
  });

  /** The whole point: the console never chooses somebody else's password. */
  it('sends no password at all', async () => {
    const { user, sent } = await openUsers();
    await openForm(user);
    await user.selectOptions(screen.getByLabelText('Company'), 'c1');
    await user.click(screen.getByRole('button', { name: 'Create user' }));

    await waitFor(() => expect(sent.some((s) => s.method === 'POST' && s.url.endsWith('/users'))).toBe(true));
    const body = sent.find((s) => s.method === 'POST' && s.url.endsWith('/users'))!.body as Record<
      string,
      unknown
    >;
    expect('password' in body).toBe(false);
    expect(body.email).toBe('new@acme.example');
    expect(body.role).toBe('user');
  });

  it('shows the link once, and says it cannot be shown again', async () => {
    const { user } = await openUsers();
    await openForm(user);
    await user.selectOptions(screen.getByLabelText('Company'), 'c1');
    await user.click(screen.getByRole('button', { name: 'Create user' }));

    expect(await screen.findByText(/Invitation link for new@acme.example/)).toBeInTheDocument();
    expect(screen.getByText(/cannot produce it again/)).toBeInTheDocument();
    expect(screen.getByText(/accept-invite\?token=inv-token-1/)).toBeInTheDocument();
  });

  /**
   * Without email delivery, the link is the account until it is used. Saying
   * so is the difference between a considered handover and a careless one.
   */
  it('warns that whoever holds the link can claim the account', async () => {
    const { user } = await openUsers();
    await openForm(user);
    await user.selectOptions(screen.getByLabelText('Company'), 'c1');
    await user.click(screen.getByRole('button', { name: 'Create user' }));

    expect(await screen.findByText(/whoever holds this link can claim the account/)).toBeInTheDocument();
    expect(screen.getByText(/not a shared channel/)).toBeInTheDocument();
  });

  it('warns what an administrator can reach', async () => {
    const { user } = await openUsers();
    await user.click(screen.getByRole('button', { name: 'Add a user' }));
    await user.selectOptions(screen.getByLabelText('Role'), 'admin');
    expect(screen.getByText(/every tenant/)).toBeInTheDocument();
  });

  it('sends no company for an administrator, who belongs to none', async () => {
    const { user, sent } = await openUsers();
    await openForm(user);
    await user.selectOptions(screen.getByLabelText('Role'), 'admin');
    await user.click(screen.getByRole('button', { name: 'Create user' }));

    await waitFor(() => expect(sent.some((s) => s.method === 'POST' && s.url.endsWith('/users'))).toBe(true));
    const body = sent.find((s) => s.method === 'POST' && s.url.endsWith('/users'))!.body as {
      companyId: string | null;
    };
    expect(body.companyId).toBeNull();
  });

  /** A company owner cannot mint a platform administrator. */
  it('does not offer the administrator role to a company owner', async () => {
    const { user } = await openUsers({ role: 'company' });
    await user.click(screen.getByRole('button', { name: 'Add a user' }));
    const roles = screen.getByLabelText('Role');
    expect(roles).toHaveTextContent('Technician');
    expect(roles).not.toHaveTextContent('Administrator');
  });

  it('surfaces a seat limit refusal from the server', async () => {
    const { user } = await openUsers({
      onCreate: () =>
        reply(409, {
          error: 'seat_limit_reached',
          message: 'Seat limit reached (10/10). Deactivate a user or raise the plan.',
        }),
    });
    await openForm(user);
    await user.selectOptions(screen.getByLabelText('Company'), 'c1');
    await user.click(screen.getByRole('button', { name: 'Create user' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Seat limit reached (10/10)');
  });

  it('shows no link when creation failed', async () => {
    const { user } = await openUsers({
      onCreate: () => reply(409, { error: 'email_taken', message: 'That email address is already in use' }),
    });
    await openForm(user);
    await user.selectOptions(screen.getByLabelText('Company'), 'c1');
    await user.click(screen.getByRole('button', { name: 'Create user' }));

    await screen.findByRole('alert');
    expect(screen.queryByText(/Invitation link for/)).not.toBeInTheDocument();
  });
});


/**
 * An invited account has no password yet. Restoring it would produce one that
 * looks usable and cannot be signed into.
 */
describe('an account that has been invited but not accepted', () => {
  it('reads as invited rather than active or suspended', async () => {
    await openUsers({ users: [row({ status: 'invited' })] });
    const tr = await rowFor('tech@acme.example');
    expect(within(tr).getByText('Invited')).toBeInTheDocument();
  });

  it('offers cancellation rather than suspension or restoration', async () => {
    await openUsers({ users: [row({ status: 'invited' })] });
    const tr = await rowFor('tech@acme.example');
    expect(within(tr).getByRole('button', { name: 'Cancel invitation' })).toBeInTheDocument();
    expect(within(tr).queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument();
  });

  it('says the link stops working when cancelled', async () => {
    const { user } = await openUsers({ users: [row({ status: 'invited' })] });
    await user.click(
      within(await rowFor('tech@acme.example')).getByRole('button', { name: 'Cancel invitation' })
    );

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/invitation for tech@acme.example is cancelled/);
    expect(status).toHaveTextContent(/link no longer works/);
  });

  it('surfaces the server’s refusal to activate one by hand', async () => {
    const { user } = await openUsers({
      users: [row({ status: 'suspended' })],
      onStatus: () =>
        reply(409, {
          error: 'invitation_pending',
          message:
            'That invitation has not been accepted yet, so there is no password to sign in with',
        }),
    });
    await user.click(within(await rowFor('tech@acme.example')).getByRole('button', { name: 'Restore' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no password to sign in with/);
  });
});
