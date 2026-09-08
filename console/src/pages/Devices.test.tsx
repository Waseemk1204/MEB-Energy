import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../store/AuthProvider';
import { App } from '../App';
import {
  DEVICE_SECURITY_LABEL,
  DEVICE_SECURITY_MEANING,
  deviceFromRow,
  type DeviceSecurity,
} from '../api/admin';

const reply = (status: number, body: unknown = {}) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }) as Response;

const row = (over: Record<string, unknown> = {}) => ({
  id: 'd1',
  company_id: 'c1',
  serial: 'KYE-000184',
  hardware_revision: 'rev-C',
  firmware_version: '1.4.2',
  assigned_battery_id: null,
  security_status: 'valid' as DeviceSecurity,
  ...over,
});

async function openDevices(devices: unknown[] = [row()], onChange?: () => Response) {
  const sent: { url: string; method: string; body: unknown }[] = [];

  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });

    if (url.endsWith('/auth/login')) {
      return reply(200, {
        accessToken: 'a1',
        refreshToken: 'r1',
        user: { id: 'u1', email: 'ops@knowyourev.example', displayName: 'Ops', role: 'admin' },
        company: null,
      });
    }
    if (url.includes('/security')) return onChange ? onChange() : reply(204);
    if (url.endsWith('/devices')) return reply(200, { devices });
    return reply(200, {});
  }) as unknown as typeof fetch;

  render(
    <MemoryRouter initialEntries={['/devices']}>
      <AuthProvider baseUrl="https://api.test" fetchImpl={fetchImpl}>
        <App />
      </AuthProvider>
    </MemoryRouter>
  );

  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Email'), 'ops@knowyourev.example');
  await user.type(screen.getByLabelText('Password'), 'a-real-passphrase');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('heading', { name: 'Devices' });

  return { user, sent };
}

const rowFor = async (serial: string) => (await screen.findByText(serial)).closest('tr')!;

beforeEach(() => {
  sessionStorage.clear();
});

describe('reading a device row', () => {
  it('maps the wire shape', () => {
    expect(deviceFromRow(row())).toEqual({
      id: 'd1',
      companyId: 'c1',
      serial: 'KYE-000184',
      hardwareRevision: 'rev-C',
      firmwareVersion: '1.4.2',
      assignedBatteryId: null,
      securityStatus: 'valid',
    });
  });
});

/**
 * Quarantine and revocation both stop a gateway working, and they mean
 * different things — one is a pause while something is checked, the other is
 * final. Calling both "disabled" would lose that.
 */
describe('what each security state means', () => {
  it('gives them distinct labels', () => {
    const labels = Object.values(DEVICE_SECURITY_LABEL);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('says quarantine is reversible and revocation is not', () => {
    expect(DEVICE_SECURITY_MEANING.quarantined).toMatch(/Reversible/i);
    expect(DEVICE_SECURITY_MEANING.revoked).toMatch(/permanently/i);
  });

  it('says an in-service gateway is the one the app will use', () => {
    expect(DEVICE_SECURITY_MEANING.valid).toMatch(/will authenticate/i);
  });
});

describe('the list', () => {
  it('shows each gateway with its firmware', async () => {
    await openDevices();
    const tr = await rowFor('KYE-000184');
    expect(within(tr).getByText('1.4.2')).toBeInTheDocument();
    expect(within(tr).getByText('In service')).toBeInTheDocument();
  });

  it('names unknown firmware rather than leaving the cell blank', async () => {
    await openDevices([row({ firmware_version: null, hardware_revision: null })]);
    const tr = await rowFor('KYE-000184');
    expect(within(tr).getAllByText('Unknown')).toHaveLength(2);
  });

  it('shows an empty fleet of gateways as empty', async () => {
    await openDevices([]);
    expect(await screen.findByText('No gateways are registered yet.')).toBeInTheDocument();
  });
});

describe('taking a gateway out of service', () => {
  it('offers both quarantine and revocation for one in service', async () => {
    await openDevices();
    const tr = await rowFor('KYE-000184');
    expect(within(tr).getByRole('button', { name: 'Quarantine' })).toBeInTheDocument();
    expect(within(tr).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });

  it('sends the new status', async () => {
    const { user, sent } = await openDevices();
    await user.click(within(await rowFor('KYE-000184')).getByRole('button', { name: 'Quarantine' }));

    await waitFor(() => expect(sent.some((s) => s.url.includes('/security'))).toBe(true));
    const call = sent.find((s) => s.url.includes('/security'))!;
    expect(call.method).toBe('PATCH');
    expect(call.body).toEqual({ securityStatus: 'quarantined' });
  });

  it('says what the change actually does', async () => {
    const { user } = await openDevices();
    await user.click(within(await rowFor('KYE-000184')).getByRole('button', { name: 'Quarantine' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('KYE-000184');
    expect(status).toHaveTextContent(/app will refuse this gateway/i);
  });

  it('offers to return a quarantined gateway to service', async () => {
    await openDevices([row({ security_status: 'quarantined' })]);
    const tr = await rowFor('KYE-000184');
    expect(within(tr).getByRole('button', { name: 'Return to service' })).toBeInTheDocument();
  });

  /** Revocation is meant to be final; reversing it is not a routine action. */
  it('offers no routine way back from revocation', async () => {
    await openDevices([row({ security_status: 'revoked' })]);
    const tr = await rowFor('KYE-000184');
    expect(within(tr).queryByRole('button')).not.toBeInTheDocument();
    expect(within(tr).getByText('Permanently out of service')).toBeInTheDocument();
  });

  it('surfaces a refusal from the server', async () => {
    const { user } = await openDevices([row()], () =>
      reply(404, { error: 'not_found', message: 'Device not found' })
    );
    await user.click(within(await rowFor('KYE-000184')).getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Device not found');
  });
});
