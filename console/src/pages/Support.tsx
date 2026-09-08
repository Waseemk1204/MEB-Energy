import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../store/AuthProvider';
import { listBatteries, type Battery } from '../api/fleet';
import {
  FORCE_PUSH_CAVEAT,
  MIN_REASON_LENGTH,
  closeSession,
  describeDisposition,
  isSomeoneOnSite,
  issueCommand,
  openSession,
  parametersFor,
  reasonIsSufficient,
  type Parameter,
} from '../api/support';

/**
 * Remote support — issuing a parameter change to a battery in the field.
 *
 * The screen is built around one fact it must never obscure: issuing a change
 * is not making a change. Nothing here shows a tick. It says whether the
 * change is collectable now or waiting for someone to arrive.
 */
export function Support() {
  const { api } = useAuth();

  const [batteries, setBatteries] = useState<Battery[]>([]);
  const [batteryId, setBatteryId] = useState('');
  const [onSite, setOnSite] = useState<boolean | null>(null);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [parameters, setParameters] = useState<Parameter[]>([]);

  const [parameterKey, setParameterKey] = useState('');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [forcePush, setForcePush] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ text: string; tone: 'good' | 'warn' } | null>(null);

  useEffect(() => {
    void listBatteries(api)
      .then((fleet) => setBatteries(fleet.batteries))
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Could not load batteries')
      );
  }, [api]);

  const battery = batteries.find((b) => b.id === batteryId) ?? null;

  // Presence is re-read whenever the pack changes, and again after each
  // issue: a technician can arrive or leave mid-session.
  const refreshPresence = useCallback(
    async (id: string) => {
      try {
        setOnSite(await isSomeoneOnSite(api, id));
      } catch {
        // Unknown is its own answer, and better than guessing "nobody".
        setOnSite(null);
      }
    },
    [api]
  );

  const onSelectBattery = async (id: string) => {
    setBatteryId(id);
    setSessionId(null);
    setOutcome(null);
    setParameterKey('');
    setParameters([]);
    setOnSite(null);
    if (!id) return;

    await refreshPresence(id);
    const model = batteries.find((b) => b.id === id)?.bmsModel;
    if (model) {
      try {
        setParameters((await parametersFor(api, model)).filter((p) => p.writable));
      } catch {
        setError('Could not load the parameters for this BMS.');
      }
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setSessionId(await openSession(api, batteryId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not open a support session');
    } finally {
      setBusy(false);
    }
  };

  const end = async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      const cancelled = await closeSession(api, sessionId, 'Closed from the console');
      setSessionId(null);
      setOutcome({
        tone: cancelled > 0 ? 'warn' : 'good',
        text:
          cancelled > 0
            ? `Session closed. ${cancelled} queued change${cancelled === 1 ? '' : 's'} cancelled — a change issued during a call must not fire hours later.`
            : 'Session closed. Nothing was left queued.',
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not close the session');
    } finally {
      setBusy(false);
    }
  };

  const selected = parameters.find((p) => p.parameterKey === parameterKey) ?? null;
  const numeric = Number(value);
  const inRange =
    selected !== null && value !== '' && Number.isFinite(numeric)
      ? numeric >= selected.minValue && numeric <= selected.maxValue
      : null;

  const canIssue =
    sessionId !== null &&
    selected !== null &&
    value !== '' &&
    Number.isFinite(numeric) &&
    reasonIsSufficient(reason) &&
    !busy;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canIssue || !sessionId || !selected) return;

    setBusy(true);
    setError(null);
    setOutcome(null);

    try {
      const result = await issueCommand(api, sessionId, {
        parameterKey: selected.parameterKey,
        value: numeric,
        reason: reason.trim(),
        forcePush,
      });
      setOutcome(describeDisposition(result.disposition));
      setValue('');
      setReason('');
      setForcePush(false);
      await refreshPresence(batteryId);
    } catch (caught) {
      // A policy refusal is a well-formed request with a "no" answer, and the
      // server's wording is the useful part — it names the rule.
      setError(caught instanceof Error ? caught.message : 'The change was refused');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1 className="page-title">Remote support</h1>
      <p className="page-sub">
        Issue a parameter change to a battery in the field. It reaches the BMS when a technician
        linked to that battery collects it — never before.
      </p>

      {error ? (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      ) : null}

      <div className="panel">
        <h2 className="panel-title">Battery</h2>
        <p className="panel-note">Changes are issued against one pack at a time.</p>

        <div className="field">
          <label htmlFor="battery">Battery</label>
          <select
            id="battery"
            value={batteryId}
            onChange={(e) => void onSelectBattery(e.target.value)}
            disabled={sessionId !== null}
          >
            <option value="">Select a battery…</option>
            {batteries.map((b) => (
              <option key={b.id} value={b.id}>
                {b.serial} · {b.cellCount}S {b.chemistry}
              </option>
            ))}
          </select>
        </div>

        {battery ? (
          <p>
            {/*
              Presence is the whole point of Mode 1, so it is stated before
              anything can be issued rather than discovered afterwards.
            */}
            {onSite === null ? (
              <span className="chip chip-neutral">Presence unknown</span>
            ) : onSite ? (
              <span className="chip chip-good">A technician is linked to this battery</span>
            ) : (
              <span className="chip chip-warn">Nobody is linked to this battery</span>
            )}
          </p>
        ) : null}

        {battery && sessionId === null ? (
          <p style={{ marginTop: 14 }}>
            <button type="button" onClick={() => void start()} disabled={busy}>
              Open support session
            </button>
          </p>
        ) : null}

        {sessionId !== null ? (
          <p style={{ marginTop: 14 }}>
            <button type="button" className="secondary" onClick={() => void end()} disabled={busy}>
              Close session
            </button>
          </p>
        ) : null}
      </div>

      {sessionId !== null ? (
        <form className="panel" onSubmit={submit}>
          <h2 className="panel-title">Issue a change</h2>
          <p className="panel-note">
            Every change is recorded against you in the audit trail, whether it lands or not.
          </p>

          <div className="field">
            <label htmlFor="parameter">Parameter</label>
            <select
              id="parameter"
              value={parameterKey}
              onChange={(e) => {
                setParameterKey(e.target.value);
                setValue('');
              }}
            >
              <option value="">Select a parameter…</option>
              {parameters.map((p) => (
                <option key={p.parameterKey} value={p.parameterKey}>
                  {p.displayName} ({p.unit})
                </option>
              ))}
            </select>
          </div>

          {selected ? (
            <>
              <div className="field">
                <label htmlFor="value">
                  New value ({selected.unit}) — permitted range {selected.minValue} to{' '}
                  {selected.maxValue}
                </label>
                <input
                  id="value"
                  type="number"
                  step="any"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
                {/*
                  Shown as guidance, not enforcement. The server decides, and
                  a refusal there is the real answer — see PRD §5.2.
                */}
                {inRange === false ? (
                  <p className="notice notice-warn" style={{ marginTop: 8 }}>
                    Outside the permitted range for this parameter. The server will refuse it.
                  </p>
                ) : null}
              </div>

              {selected.dangerLevel === 'Critical' ? (
                <p className="notice notice-warn">
                  {selected.displayName} is a protection threshold. Changing it alters what the
                  BMS will allow before it disconnects the pack.
                </p>
              ) : null}
            </>
          ) : null}

          <div className="field">
            <label htmlFor="reason">
              Reason (required, at least {MIN_REASON_LENGTH} characters)
            </label>
            <textarea
              id="reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="force" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                id="force"
                type="checkbox"
                style={{ width: 'auto' }}
                checked={forcePush}
                onChange={(e) => setForcePush(e.target.checked)}
              />
              Force Push
            </label>
            {forcePush ? <p className="notice notice-warn">{FORCE_PUSH_CAVEAT}</p> : null}
          </div>

          <button type="submit" disabled={!canIssue}>
            {busy ? 'Issuing…' : 'Issue change'}
          </button>
        </form>
      ) : null}

      {outcome ? (
        <p role="status" className={`notice notice-${outcome.tone === 'good' ? 'info' : 'warn'}`}>
          {outcome.text}
        </p>
      ) : null}
    </>
  );
}
