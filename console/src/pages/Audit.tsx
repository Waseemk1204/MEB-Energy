import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../store/AuthProvider';
import {
  DEFAULT_AUDIT_ROWS,
  RESULT_LABEL,
  RESULT_TONE,
  SOURCE_LABEL,
  describeChange,
  formatWhen,
  listAudit,
  wasUploadedLate,
  type AuditEvent,
  type WriteResult,
  type WriteSource,
} from '../api/audit';

/**
 * The audit trail.
 *
 * Everything attempted, in order, including what was refused. Admin remote
 * writes never prompt the technician (PRD §6.3), so for a change made from
 * this console, this table is the primary account that it happened at all.
 */
export function Audit() {
  const { api } = useAuth();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [result, setResult] = useState<WriteResult | ''>('');
  const [source, setSource] = useState<WriteSource | ''>('');

  const load = useCallback(async () => {
    setError(null);
    try {
      // Filtered by the server. The trail is capped, so narrowing a fetched
      // page here would quietly hide everything past the cap — and a filtered
      // view that silently omits matches is worse than no filter at all.
      setEvents(
        await listAudit(api, {
          result: result || undefined,
          source: source || undefined,
        })
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not load the audit trail');
    }
  }, [api, result, source]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <h1 className="page-title">Audit trail</h1>
      <p className="page-sub">
        Every attempted parameter change, successful or not, newest first.
      </p>

      <div className="panel">
        <h2 className="panel-title">Narrow it down</h2>
        <p className="panel-note">
          Filtering happens on the server, so it searches the whole trail rather than the page
          already fetched.
        </p>

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <div className="field" style={{ minWidth: 220, marginBottom: 0 }}>
            <label htmlFor="result">Outcome</label>
            <select
              id="result"
              value={result}
              onChange={(e) => setResult(e.target.value as WriteResult | '')}
            >
              <option value="">Any outcome</option>
              <option value="success">Applied</option>
              <option value="adjusted">Adjusted by BMS</option>
              <option value="rejected">Refused</option>
              <option value="timeout">Timed out</option>
              <option value="indeterminate">Unconfirmed</option>
            </select>
          </div>

          <div className="field" style={{ minWidth: 220, marginBottom: 0 }}>
            <label htmlFor="source">Source</label>
            <select
              id="source"
              value={source}
              onChange={(e) => setSource(e.target.value as WriteSource | '')}
            >
              <option value="">Any source</option>
              <option value="local">On site</option>
              <option value="admin_remote">Remote</option>
              <option value="admin_force_push">Force Push</option>
            </select>
          </div>
        </div>
      </div>

      {error ? (
        <p role="alert" className="notice notice-error">
          {error}{' '}
          <button type="button" className="secondary" onClick={() => void load()}>
            Retry
          </button>
        </p>
      ) : null}

      <div className="panel">
        {events === null && !error ? (
          <p className="empty">Loading…</p>
        ) : events && events.length === 0 ? (
          <p className="empty">
            {result || source
              ? 'No changes match that filter.'
              : 'Nothing has been changed yet.'}
          </p>
        ) : (
          <table>
            <caption className="panel-note" style={{ captionSide: 'top', textAlign: 'left' }}>
              Refusals are listed alongside successes — a trail of successes cannot answer what
              someone tried to do. “Unconfirmed” means the app could not tell whether the BMS
              applied the change; it is not a failure.
              {/*
                A page that is exactly full is probably not the whole story, and
                saying so beats letting someone read it as complete.
              */}
              {events && events.length >= DEFAULT_AUDIT_ROWS
                ? ` Showing the most recent ${DEFAULT_AUDIT_ROWS}; there may be more.`
                : ''}
            </caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Parameter</th>
                <th scope="col">Change</th>
                <th scope="col">Outcome</th>
                <th scope="col">Source</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {(events ?? []).map((event) => (
                <tr key={event.id}>
                  <td>
                    {formatWhen(event.occurredAt)}
                    {/*
                      The device's clock and the server's are different facts.
                      Where they disagree materially, say so rather than
                      silently showing one of them.
                    */}
                    {wasUploadedLate(event) ? (
                      <span
                        className="chip chip-neutral"
                        style={{ marginLeft: 8 }}
                        title={`Recorded by the server ${formatWhen(event.recordedAt, event.recordedAt + (event.recordedAt - event.occurredAt))} later`}
                      >
                        uploaded later
                      </span>
                    ) : null}
                  </td>
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
                  <td style={{ color: event.reason ? undefined : 'var(--ink-faint)' }}>
                    {event.reason ?? 'None recorded'}
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
