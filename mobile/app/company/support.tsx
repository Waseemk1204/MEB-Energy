import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { useTheme } from '../../src/theme/ThemeProvider';
import { radii, space } from '../../src/theme/tokens';
import { type as T } from '../../src/theme/type';
import { ScreenScaffold } from '../../src/ui/ScreenScaffold';
import { DataRow, PrimaryButton, RowGroup, SectionLabel, StatusChip } from '../../src/ui/primitives';
import { api } from '../../src/api/session';
import { listFleet, type FleetPack } from '../../src/api/company';
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
  type RemoteParameter,
} from '../../src/api/support';
import { logWarn } from '../../src/diagnostics/fieldLog';

/**
 * Remote support — issuing a parameter change to a pack in the field.
 *
 * The screen is built around one fact it must never obscure: issuing a change
 * is not making a change. Nothing here shows a tick. It says whether the
 * change is collectable now or waiting for someone to arrive.
 */
export default function RemoteSupport() {
  const { p } = useTheme();

  const [packs, setPacks] = useState<FleetPack[] | null>(null);
  const [pack, setPack] = useState<FleetPack | null>(null);
  const [onSite, setOnSite] = useState<boolean | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [parameters, setParameters] = useState<RemoteParameter[]>([]);
  const [selected, setSelected] = useState<RemoteParameter | null>(null);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [forcePush, setForcePush] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ text: string; tone: 'good' | 'warn' } | null>(null);

  useEffect(() => {
    void listFleet(api)
      .then((fleet) => setPacks(fleet.filter((b) => b.status === 'active')))
      .catch((caught: unknown) => {
        const message = caught instanceof Error ? caught.message : 'Could not load packs';
        logWarn('ui', 'Remote support failed', { message });
        setError(message);
      });
  }, []);

  // Presence is re-read whenever the pack changes, and again after each
  // issue: a technician can arrive or leave mid-session.
  const refreshPresence = useCallback(async (id: string) => {
    try {
      setOnSite(await isSomeoneOnSite(api, id));
    } catch {
      // Unknown is its own answer, and better than guessing "nobody".
      setOnSite(null);
    }
  }, []);

  const choosePack = async (next: FleetPack) => {
    setPack(next);
    setSessionId(null);
    setOutcome(null);
    setSelected(null);
    setParameters([]);
    setOnSite(null);
    setError(null);
    await refreshPresence(next.id);
    if (next.bms_model) {
      try {
        setParameters((await parametersFor(api, next.bms_model)).filter((x) => x.writable));
      } catch {
        setError('Could not load the parameters for this BMS.');
      }
    }
  };

  const start = async () => {
    if (!pack) return;
    setBusy(true);
    setError(null);
    try {
      setSessionId(await openSession(api, pack.id));
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
      const cancelled = await closeSession(api, sessionId, 'Closed from the app');
      setSessionId(null);
      setSelected(null);
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

  const issue = async () => {
    if (!canIssue || !sessionId || !selected || !pack) return;
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
      await refreshPresence(pack.id);
    } catch (caught) {
      // A policy refusal is a well-formed request with a "no" answer, and the
      // server's wording is the useful part — it names the rule.
      setError(caught instanceof Error ? caught.message : 'The change was refused');
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = [styles.input, { backgroundColor: p.panelBase, color: p.inkStrong, borderColor: p.panelStitch }];

  return (
    <ScreenScaffold
      title="Remote support"
      sub={sessionId ? `Session open · ${pack?.serial ?? ''}` : 'Change a parameter from here'}
    >
      <Text style={[T.caption, { color: p.inkSoft, marginTop: 8 }]}>
        A change reaches the BMS when a technician linked to that pack collects it — never
        before.
      </Text>

      {error ? (
        <View style={[styles.notice, { backgroundColor: p.panelAlt }]}>
          <Text style={[T.rowLabel, { color: p.critical }]}>{error}</Text>
        </View>
      ) : null}
      {outcome ? (
        <View
          style={[styles.notice, { backgroundColor: p.panelAlt, borderLeftWidth: 3, borderLeftColor: outcome.tone === 'good' ? p.good : p.warn }]}
          accessibilityRole="alert"
        >
          <Text style={[T.rowLabel, { color: p.inkStrong }]}>{outcome.text}</Text>
        </View>
      ) : null}

      <SectionLabel>Pack</SectionLabel>
      {!packs ? (
        error ? null : (
          <View style={styles.loading}>
            <ActivityIndicator color={p.accent} />
          </View>
        )
      ) : packs.length === 0 ? (
        <Text style={[T.rowLabel, { color: p.inkSoft }]}>No packs in service.</Text>
      ) : sessionId ? (
        <RowGroup>
          <DataRow label={pack!.serial} value={`${pack!.cell_count}S ${pack!.chemistry}`} />
        </RowGroup>
      ) : (
        <RowGroup>
          {packs.map((b) => (
            <DataRow
              key={b.id}
              label={b.serial}
              value={pack?.id === b.id ? 'Selected' : `${b.cell_count}S ${b.chemistry}`}
              onPress={() => void choosePack(b)}
            />
          ))}
        </RowGroup>
      )}

      {pack ? (
        <View style={styles.presence}>
          {/*
            Presence is the whole point of Mode 1, so it is stated before
            anything can be issued rather than discovered afterwards.
          */}
          {onSite === null ? (
            <StatusChip tone="neutral" label="Presence unknown" />
          ) : onSite ? (
            <StatusChip tone="good" label="A technician is linked to this pack" />
          ) : (
            <StatusChip tone="warn" label="Nobody is linked to this pack" />
          )}
        </View>
      ) : null}

      {pack && sessionId === null ? (
        <PrimaryButton label={busy ? 'Opening…' : 'Open support session'} onPress={() => void start()} disabled={busy} />
      ) : null}

      {sessionId !== null ? (
        <>
          <SectionLabel>Issue a change</SectionLabel>
          <Text style={[T.caption, { color: p.inkSoft, marginBottom: 8 }]}>
            Every change is recorded against you in the ledger, whether it lands or not.
          </Text>

          {parameters.length === 0 ? (
            <Text style={[T.rowLabel, { color: p.inkSoft }]}>
              No writable parameters are defined for this pack’s BMS.
            </Text>
          ) : (
            <RowGroup>
              {parameters.map((x) => (
                <DataRow
                  key={x.parameterKey}
                  label={x.displayName}
                  value={selected?.parameterKey === x.parameterKey ? 'Selected' : x.unit}
                  level={x.dangerLevel}
                  onPress={() => {
                    setSelected(x);
                    setValue('');
                  }}
                />
              ))}
            </RowGroup>
          )}

          {selected ? (
            <View style={[styles.form, { backgroundColor: p.panelAlt }]}>
              <Text style={[T.sectionLabel, { color: p.inkFaint }]}>
                New value ({selected.unit}) · {selected.minValue} to {selected.maxValue}
              </Text>
              <TextInput
                value={value}
                onChangeText={setValue}
                keyboardType="decimal-pad"
                accessibilityLabel={`New value for ${selected.displayName}`}
                style={inputStyle}
              />
              {/* Guidance, not enforcement. The server decides — PRD §5.2. */}
              {inRange === false ? (
                <Text style={[T.caption, { color: p.warn }]}>
                  Outside the permitted range. The server will refuse it.
                </Text>
              ) : null}
              {selected.dangerLevel === 'Critical' ? (
                <Text style={[T.caption, { color: p.warn }]}>
                  {selected.displayName} is a protection threshold. Changing it alters what the BMS
                  will allow before it disconnects the pack.
                </Text>
              ) : null}

              <Text style={[T.sectionLabel, { color: p.inkFaint, marginTop: 6 }]}>
                Reason (at least {MIN_REASON_LENGTH} characters)
              </Text>
              <TextInput
                value={reason}
                onChangeText={setReason}
                multiline
                accessibilityLabel="Reason"
                style={[inputStyle, { minHeight: 64 }]}
              />

              <View style={styles.forceRow}>
                <View style={{ flexShrink: 1 }}>
                  <Text style={[T.rowLabel, { color: p.inkStrong }]}>Force Push</Text>
                  {forcePush ? (
                    <Text style={[T.caption, { color: p.warn }]}>{FORCE_PUSH_CAVEAT}</Text>
                  ) : null}
                </View>
                <Switch
                  value={forcePush}
                  onValueChange={setForcePush}
                  accessibilityLabel="Force Push"
                  trackColor={{ false: p.panelTrack, true: p.warn }}
                  thumbColor={p.panelBase}
                />
              </View>

              <PrimaryButton label={busy ? 'Issuing…' : 'Issue change'} onPress={() => void issue()} disabled={!canIssue} />
            </View>
          ) : null}

          <Pressable onPress={() => void end()} disabled={busy} accessibilityRole="button" style={styles.close}>
            <Text style={[T.tabLabel, { color: p.critical }]}>Close session</Text>
          </Pressable>
        </>
      ) : null}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  loading: { paddingVertical: 40, alignItems: 'center' },
  notice: { borderRadius: radii.card, padding: space.panel, marginTop: 8, marginBottom: 4 },
  presence: { flexDirection: 'row', marginTop: 10, marginBottom: 12 },
  form: { borderRadius: radii.card, padding: space.panel, gap: 8, marginTop: 10 },
  input: { borderRadius: radii.card - 8, borderWidth: 1, paddingHorizontal: 13, paddingVertical: 11 },
  forceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 48 },
  close: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 14 },
});
