import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../store/AuthProvider';
import { ApiError } from '../api/client';
import { describeReading, getBattery, type Battery as Pack } from '../api/fleet';
import { listHistory, type Reading } from '../api/history';
import {
  RESULT_LABEL,
  RESULT_TONE,
  SOURCE_LABEL,
  describeChange,
  formatWhen,
  listAudit,
  type AuditEvent,
} from '../api/audit';
import { Sparkline } from '../ui/Sparkline';

/**
 * One pack: what it is, what it has reported, and what has been changed on it.
 *
 * The fleet table used to be a dead end. This is what a row leads to, and it
 * puts the three things an administrator actually asks about — is it healthy,
 * has it been reporting, who last changed it — on one page.
 */
export function Battery() {
  const { api } = useAuth();
  const { id = '' } = useParams();

  const [pack, setPack] = useState<Pack | null>(null);
  const [readings, setReadings] = useState<Reading[] | null>(null);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      // Each fetched directly. Picking this pack out of the fleet listing would
      // work until that listing is paged, and then quietly stop finding
      // batteries that plainly exist.
      const [battery, history, audit] = await Promise.all([
        getBattery(api, id),
        listHistory(api, id),
        // Filtered by the server, not here. The trail is capped at 200 rows by
        // default, so narrowing a fleet-wide page down to this pack would
        // silently miss anything older and report "nothing has been changed" —
        // a false statement about an audit trail rather than an empty one.
        listAudit(api, { batteryId: id }),
      ]);

      setPack(battery);
      setReadings(history);
      setEvents(audit);
    } catch (caught) {
      // A 404 here means the battery is not this tenant's, or is not there —
      // the server deliberately does not distinguish, and neither does this.
      if (caught instanceof ApiError && caught.isNotFound) {
        setPack(null);
        setReadings([]);
        setEvents([]);
        return;
      }
      setError(caught instanceof Error ? caught.message : 'Could not load this battery');
    }
  }, [api, id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <>
        <p>
          <Link to="/batteries">← All batteries</Link>
        </p>
        <p role="alert" className="notice notice-error">
          {error}{' '}
          <button type="button" className="secondary" onClick={() => void load()}>
            Retry
          </button>
        </p>
      </>
    );
  }

  if (!pack) {
    return (
      <>
        <p>
          <Link to="/batteries">← All batteries</Link>
        </p>
        <p className="empty">{readings === null ? 'Loading…' : 'That battery is not in your fleet.'}</p>
      </>
    );
  }

  const reading = describeReading(pack.lastReading);
  const faults = pack.lastReading?.faultCount ?? 0;

  return (
    <>
      <p>
        <Link to="/batteries">← All batteries</Link>
      </p>

      <h1 className="page-title figure">{pack.serial}</h1>
      <p className="page-sub">
        {pack.cellCount}S {pack.chemistry} · {pack.bmsModel ?? 'BMS unknown'}
      </p>

      <div className="panel">
        <h2 className="panel-title">Last reported</h2>
        <p className="panel-note">
          A reading is only as current as the time beside it. Nothing here is live — the app
          reports while a technician is linked.
        </p>

        <p>
          <span className="figure" style={{ fontSize: 26 }}>
            {reading.soc}
          </span>{' '}
          <span className={`chip chip-${reading.tone}`}>{reading.age}</span>{' '}
          {faults > 0 ? (
            <span className="chip chip-critical">{faults} active fault{faults === 1 ? '' : 's'}</span>
          ) : reading.known ? (
            <span className="chip chip-good">No faults</span>
          ) : null}
        </p>
      </div>

      <div className="panel">
        <h2 className="panel-title">History</h2>
        <p className="panel-note">
          {readings === null
            ? 'Loading…'
            : `${readings.length} stored reading${readings.length === 1 ? '' : 's'}. The app thins its 2 Hz stream before upload, but always keeps the moment a fault appeared or cleared.`}
        </p>

        {readings && readings.length > 0 ? (
          <>
            <Sparkline
              readings={readings}
              pick={(r) => r.soc}
              label="State of charge"
              unit="%"
              floor={0}
              ceiling={100}
            />
            <Sparkline
              readings={readings}
              pick={(r) => r.packVoltage}
              label="Pack voltage"
              unit="V"
            />
            <Sparkline
              readings={readings}
              pick={(r) => r.temperatureC}
              label="Temperature"
              unit="°C"
              tone="var(--warn)"
            />
            <Sparkline
              readings={readings}
              pick={(r) => r.faultCount}
              label="Active faults"
              unit=""
              floor={0}
              tone="var(--critical)"
            />
          </>
        ) : readings !== null ? (
          <p className="empty">This pack has never reported.</p>
        ) : null}
      </div>

      <div className="panel">
        <h2 className="panel-title">Changes to this pack</h2>
        <p className="panel-note">
          Every attempt, successful or not. “Unconfirmed” means the app could not tell whether the
          BMS applied it.
        </p>

        {events === null ? (
          <p className="empty">Loading…</p>
        ) : events.length === 0 ? (
          <p className="empty">Nothing has been changed on this pack.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Parameter</th>
                <th scope="col">Change</th>
                <th scope="col">Outcome</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td>{formatWhen(event.occurredAt)}</td>
                  <td className="figure">{event.parameterKey ?? '—'}</td>
                  <td className="figure">{describeChange(event)}</td>
                  <td>
                    <span className={`chip chip-${RESULT_TONE[event.result]}`}>
                      {RESULT_LABEL[event.result]}
                    </span>
                  </td>
                  <td>
                    <span
                      className={
                        event.source === 'admin_force_push' ? 'chip chip-warn' : 'chip chip-neutral'
                      }
                    >
                      {SOURCE_LABEL[event.source]}
                    </span>
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
