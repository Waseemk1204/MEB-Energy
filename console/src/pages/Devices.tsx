import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../store/AuthProvider';
import {
  DEVICE_SECURITY_LABEL,
  DEVICE_SECURITY_MEANING,
  DEVICE_SECURITY_TONE,
  listDevices,
  setDeviceSecurity,
  type Device,
  type DeviceSecurity,
} from '../api/admin';

/**
 * KnowyourEV gateways (PRD §8.1).
 *
 * The app refuses to authenticate a device that is not `valid`, so the status
 * column here is the lever that takes a suspect gateway out of service. The
 * two non-valid states mean different things and are labelled as such:
 * quarantine is reversible while something is checked, revocation is not.
 */
export function Devices() {
  const { api } = useAuth();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDevices(await listDevices(api));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load devices');
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (device: Device, next: DeviceSecurity) => {
    setError(null);
    setNotice(null);
    try {
      await setDeviceSecurity(api, device.id, next);
      setNotice(`${device.serial}: ${DEVICE_SECURITY_MEANING[next]}`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not change that device');
    }
  };

  return (
    <>
      <h1 className="page-title">Devices</h1>
      <p className="page-sub">
        KnowyourEV gateways. The app refuses to talk to any gateway not in service.
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

      <div className="panel">
        {devices === null && !error ? (
          <p className="empty">Loading…</p>
        ) : devices && devices.length === 0 ? (
          <p className="empty">No gateways are registered yet.</p>
        ) : (
          <table>
            <caption className="panel-note" style={{ captionSide: 'top', textAlign: 'left' }}>
              Quarantine is reversible — use it while a gateway is being checked. Revocation is
              for one that is lost or compromised.
            </caption>
            <thead>
              <tr>
                <th scope="col">Serial</th>
                <th scope="col">Hardware</th>
                <th scope="col">Firmware</th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {(devices ?? []).map((d) => (
                <tr key={d.id}>
                  <td className="figure">{d.serial}</td>
                  <td>{d.hardwareRevision ?? <span style={{ color: 'var(--ink-faint)' }}>Unknown</span>}</td>
                  <td className="figure">
                    {d.firmwareVersion ?? <span style={{ color: 'var(--ink-faint)' }}>Unknown</span>}
                  </td>
                  <td>
                    <span
                      className={`chip chip-${DEVICE_SECURITY_TONE[d.securityStatus]}`}
                      title={DEVICE_SECURITY_MEANING[d.securityStatus]}
                    >
                      {DEVICE_SECURITY_LABEL[d.securityStatus]}
                    </span>
                  </td>
                  <td>
                    {d.securityStatus === 'valid' ? (
                      <>
                        <button type="button" className="secondary" onClick={() => void change(d, 'quarantined')}>
                          Quarantine
                        </button>{' '}
                        <button type="button" className="danger" onClick={() => void change(d, 'revoked')}>
                          Revoke
                        </button>
                      </>
                    ) : d.securityStatus === 'quarantined' ? (
                      <>
                        <button type="button" className="secondary" onClick={() => void change(d, 'valid')}>
                          Return to service
                        </button>{' '}
                        <button type="button" className="danger" onClick={() => void change(d, 'revoked')}>
                          Revoke
                        </button>
                      </>
                    ) : (
                      // Revocation is meant to be final. Reversing it is still
                      // possible, but it is not offered as a routine action.
                      <span style={{ color: 'var(--ink-faint)' }}>Permanently out of service</span>
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
