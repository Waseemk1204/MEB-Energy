import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../store/AuthProvider';
import { byAttention, describeReading, listBatteries, type Battery } from '../api/fleet';

/**
 * The fleet.
 *
 * Nothing is shown that the server did not send, and no state of charge is
 * shown without the age of the reading it came from.
 */
export function Batteries() {
  const { api } = useAuth();
  const [batteries, setBatteries] = useState<Battery[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const fleet = await listBatteries(api);
      setBatteries(fleet.batteries.sort(byAttention));
      setTruncated(fleet.truncated);
    } catch (caught) {
      // The list is left as it was rather than emptied: an administrator
      // seeing rows vanish on a transient failure would read it as packs
      // having been removed.
      setError(caught instanceof Error ? caught.message : 'Could not load batteries');
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <h1 className="page-title">Batteries</h1>
      <p className="page-sub">
        {truncated
          ? 'Part of your fleet — there are more packs than this page returned.'
          : 'Every pack registered to your company, with the last reading it reported.'}
      </p>

      {error ? (
        <p role="alert" className="notice notice-error">
          {error}{' '}
          <button type="button" className="secondary" onClick={() => void load()}>
            Retry
          </button>
        </p>
      ) : null}

      <div className="panel">
        {batteries === null && !error ? (
          <p className="empty">Loading…</p>
        ) : batteries && batteries.length === 0 ? (
          <p className="empty">No batteries are registered yet.</p>
        ) : (
          <table>
            <caption className="panel-note" style={{ captionSide: 'top', textAlign: 'left' }}>
              A pack with active faults sorts to the top. A reading is only as current as the
              time beside it. Open a serial for its history and the changes made to it.
            </caption>
            <thead>
              <tr>
                <th scope="col">Serial</th>
                <th scope="col">Pack</th>
                <th scope="col">BMS</th>
                <th scope="col">Charge</th>
                <th scope="col">Last reported</th>
                <th scope="col">Faults</th>
              </tr>
            </thead>
            <tbody>
              {(batteries ?? []).map((b) => {
                const reading = describeReading(b.lastReading);
                const faults = b.lastReading?.faultCount ?? 0;

                return (
                  <tr key={b.id}>
                    <td className="figure">
                      <Link to={`/batteries/${b.id}`}>{b.serial}</Link>
                    </td>
                    <td>
                      {b.cellCount}S {b.chemistry}
                    </td>
                    <td>{b.bmsModel ?? <span style={{ color: 'var(--ink-faint)' }}>Unknown</span>}</td>
                    <td className="figure">{reading.soc}</td>
                    <td>
                      <span className={`chip chip-${reading.tone}`}>{reading.age}</span>
                    </td>
                    <td>
                      {faults === 0 ? (
                        <span style={{ color: 'var(--ink-faint)' }}>
                          {reading.known ? 'None' : '—'}
                        </span>
                      ) : (
                        <span className="chip chip-critical">
                          {faults} active
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
