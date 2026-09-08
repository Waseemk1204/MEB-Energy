import React, { useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlertTriangle, Minus, Plus, X } from 'lucide-react-native';

import { useTheme } from '../../src/theme/ThemeProvider';
import { dangerColor, radii } from '../../src/theme/tokens';
import { type as T } from '../../src/theme/type';
import { LeatherPanel } from '../../src/ui/LeatherPanel';
import { DangerDot, PrimaryButton } from '../../src/ui/primitives';
import { StepList } from '../../src/ui/StepList';
import { useProfileStore } from '../../src/store/useProfileStore';
import { useSettingsStore } from '../../src/store/useSettingsStore';
import { useActivityStore } from '../../src/store/useActivityStore';
import { useSessionStore } from '../../src/store/useSessionStore';
import { useTelemetryStore } from '../../src/store/useTelemetryStore';
import { PinPad } from '../../src/ui/PinPad';
import { executeWrite, type WriteOutcome } from '../../src/telemetry/writeOutcome';
import { PIN_DIGITS } from '../../src/store/pin';
import {
  MAX_PIN_ATTEMPTS,
  lockoutSecondsLeft,
  useSecurityStore,
} from '../../src/store/useSecurityStore';

const OUTCOME_TITLE: Record<WriteOutcome, string> = {
  success: 'Written',
  adjusted: 'Written, with a different value',
  rejected: 'Rejected by the BMS',
  timeout: 'No response — outcome unknown',
  indeterminate: 'Outcome unknown',
};

type Stage = 'idle' | 'pin' | 'writing' | 'reading' | 'auditing' | 'done' | 'settled';

/**
 * Safe write (PRD §6.2), in order:
 *   current value → new value → validation → safety warning → acknowledgement
 *   → reason (mandatory when Critical) → execute → read back → audit.
 *
 * The primary button stays disabled until every gate passes and names the
 * actual change rather than saying "Confirm" — someone tapping fast should
 * still be told what they are about to do to a live battery.
 */
export default function WriteConfirmation() {
  const { p } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { parameterKey } = useLocalSearchParams<{ parameterKey: string }>();

  // Deliberately the profile store, not the bundled file: where the server has
  // been reached its bounds are in force, and this screen is the one that
  // decides what a technician is allowed to send.
  const param = useProfileStore((s) => s.parameterFor(String(parameterKey)));
  const values = useSettingsStore((s) => s.values);
  const setValue = useSettingsStore((s) => s.setValue);
  const addActivity = useActivityStore((s) => s.add);
  const batteryId = useSessionStore((s) => s.connectedBatteryId);
  const source = useTelemetryStore((s) => s.source);

  const current = param ? (values[param.parameter_key] ?? param.value) : 0;
  const [next, setNext] = useState(current);
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<WriteOutcome | null>(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);

  const pinSet = useSecurityStore((s) => s.pinSet);
  const checkPin = useSecurityStore((s) => s.check);
  const failedAttempts = useSecurityStore((s) => s.failedAttempts);
  const lockedUntil = useSecurityStore((s) => s.lockedUntil);

  const critical = param?.danger_level === 'Critical';
  const reasonRequired = critical;
  /** PRD §6.2's optional PIN/re-authentication step, applied to Critical only. */
  const pinRequired = critical && pinSet;

  /**
   * Deep-linking straight to this modal (a notification, a shared link, or a
   * cold start on this route) leaves nothing on the stack, and router.back()
   * silently does nothing — stranding the user on a completed write. Fall back
   * to Settings, which is where this screen is reached from in normal use.
   */
  const dismiss = React.useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/settings');
  }, [router]);

  const validation = useMemo(() => {
    if (!param) return 'Unknown parameter';
    if (Number.isNaN(next)) return 'Enter a number';
    if (next < param.min) return `Below the supported minimum of ${param.min} ${param.unit}`;
    if (next > param.max) return `Above the supported maximum of ${param.max} ${param.unit}`;
    if (param.data_type === 'integer' && !Number.isInteger(next)) return 'Must be a whole number';
    return null;
  }, [next, param]);

  if (!param) {
    return (
      <View style={{ flex: 1, backgroundColor: p.panelBase, padding: 24, paddingTop: insets.top + 24 }}>
        <Text style={[T.rowLabel, { color: p.inkStrong }]}>Unknown parameter.</Text>
      </View>
    );
  }

  const changed = Math.abs(next - current) > 1e-9;
  const ready =
    !validation && changed && acknowledged && (!reasonRequired || reason.trim().length > 0) && stage === 'idle';

  const fmt = (v: number) => `${v.toFixed(param.precision)} ${param.unit}`;

  /** Every gate has passed; ask for the PIN if one guards this parameter. */
  const submit = () => {
    if (pinRequired) {
      setPin('');
      setPinError(null);
      setStage('pin');
      return;
    }
    void execute();
  };

  const onPinComplete = async (entered: string) => {
    const ok = await checkPin(entered);
    if (ok) {
      setPin('');
      setPinError(null);
      void execute();
      return;
    }
    setPin('');
    const left = MAX_PIN_ATTEMPTS - useSecurityStore.getState().failedAttempts;
    setPinError(
      left > 0
        ? `Incorrect PIN. ${left} attempt${left === 1 ? '' : 's'} left.`
        : 'Too many attempts. Try again shortly.'
    );
  };

  const execute = async () => {
    setError(null);
    setOutcome(null);
    setStage('writing');

    const classified = await executeWrite(source, param.parameter_key, next, param.precision);

    setStage('reading');
    await new Promise((r) => setTimeout(r, 280));
    setStage('auditing');
    await new Promise((r) => setTimeout(r, 220));

    // The audit records what happened, including "we do not know".
    addActivity({
      parameterKey: param.parameter_key,
      displayName: param.display_name,
      oldValue: fmt(current),
      newValue:
        classified.confirmedValue !== null ? fmt(classified.confirmedValue) : fmt(next),
      actor: 'You',
      reason: reason.trim() || undefined,
      source: 'local',
      dangerLevel: param.danger_level,
      result: classified.outcome,
    });

    // Only a confirmed read-back may change what the app claims is on the BMS.
    // An unconfirmed write leaves the old value showing, so nothing downstream
    // presents a guess as fact.
    if (classified.confirmedValue !== null) {
      setValue(param.parameter_key, classified.confirmedValue);
    }

    // Push it now rather than waiting for the next link to this pack. A
    // technician who writes and then disconnects would otherwise leave the
    // only record of a change on their phone until they happened to return.
    // Not awaited: the write is done, and the upload must not delay saying so.
    if (batteryId) void useActivityStore.getState().sync(batteryId);

    setOutcome(classified.outcome);
    setError(classified.message);

    if (classified.outcome === 'success') {
      setStage('done');
      setTimeout(dismiss, 700);
    } else {
      setStage('settled');
    }
  };

  const step = param.step;
  const stitchColor = critical ? p.critical : p.leatherStitch;

  return (
    <View style={{ flex: 1, backgroundColor: p.panelBase }}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Leather is used for exactly one modal, to mark it as consequential. */}
        <LeatherPanel tone="hero" radius={0} style={{ paddingTop: insets.top + 10 }}>
          <View style={[StyleSheet.absoluteFill, { margin: 9, borderWidth: 2, borderStyle: 'dashed', borderColor: stitchColor, borderRadius: 4, opacity: 0.9 }]} pointerEvents="none" />
          <View style={styles.head}>
            <View style={{ flexShrink: 1 }}>
              <View style={styles.levelRow}>
                <DangerDot level={param.danger_level} />
                <Text style={[T.tabLabel, { color: p.leatherInkSoft }]}>
                  {param.danger_level} parameter
                </Text>
              </View>
              <Text style={[T.screenTitle, { color: p.leatherInk, fontSize: 22 }]}>
                {param.display_name}
              </Text>
            </View>
            <Pressable
              onPress={dismiss}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              hitSlop={12}
              style={styles.close}
            >
              <X size={18} color={p.leatherInkSoft} strokeWidth={2.4} />
            </Pressable>
          </View>

          <View style={styles.compare}>
            <View style={styles.compareCell}>
              <Text style={[T.tabLabel, { color: p.leatherInkSoft }]}>Current</Text>
              <Text style={[T.metricValue, { color: p.leatherInk, fontSize: 24, marginTop: 6 }]}>
                {fmt(current)}
              </Text>
            </View>
            <Text style={[T.metricValue, { color: p.leatherInkSoft, fontSize: 20 }]}>→</Text>
            <View style={styles.compareCell}>
              <Text style={[T.tabLabel, { color: p.leatherInkSoft }]}>New</Text>
              <Text
                style={[
                  T.metricValue,
                  { color: changed ? p.leatherInk : p.leatherInkSoft, fontSize: 24, marginTop: 6 },
                ]}
              >
                {fmt(next)}
              </Text>
            </View>
          </View>

          <View style={styles.stepper}>
            <Pressable
              onPress={() => setNext((v) => Math.max(param.min, +(v - step).toFixed(6)))}
              accessibilityRole="button"
              accessibilityLabel="Decrease"
              style={[styles.stepBtn, { borderColor: p.leatherInkSoft }]}
            >
              <Minus size={18} color={p.leatherInk} strokeWidth={2.4} />
            </Pressable>
            <TextInput
              value={String(next)}
              onChangeText={(t) => setNext(Number(t.replace(',', '.')))}
              keyboardType="numbers-and-punctuation"
              accessibilityLabel={`${param.display_name} new value`}
              style={[
                T.metricValue,
                styles.input,
                { color: p.leatherInk, borderColor: p.leatherInkSoft, fontSize: 20 },
              ]}
            />
            <Pressable
              onPress={() => setNext((v) => Math.min(param.max, +(v + step).toFixed(6)))}
              accessibilityRole="button"
              accessibilityLabel="Increase"
              style={[styles.stepBtn, { borderColor: p.leatherInkSoft }]}
            >
              <Plus size={18} color={p.leatherInk} strokeWidth={2.4} />
            </Pressable>
          </View>

          <Text style={[T.caption, { color: p.leatherInkSoft, textAlign: 'center', paddingBottom: 22 }]}>
            Supported range {param.min}–{param.max} {param.unit} · datasheet typical {param.typ}
          </Text>
        </LeatherPanel>

        <View style={styles.body}>
          {validation && changed && (
            <View style={[styles.notice, { backgroundColor: p.panelAlt, borderLeftColor: p.critical }]}>
              <AlertTriangle size={15} color={p.critical} strokeWidth={2.2} />
              <Text style={[T.caption, { color: p.inkStrong, flex: 1 }]}>{validation}</Text>
            </View>
          )}

          <View
            style={[
              styles.notice,
              {
                backgroundColor: p.panelAlt,
                borderLeftColor: dangerColor(p, param.danger_level),
              },
            ]}
          >
            <AlertTriangle size={15} color={dangerColor(p, param.danger_level)} strokeWidth={2.2} />
            <Text style={[T.caption, { color: p.inkSoft, flex: 1 }]}>
              {critical
                ? 'This is a safety-critical protection threshold. Weakening it can allow conditions that damage the pack or start a fire. The change is written to the BMS and recorded in the audit log against your account.'
                : 'This change is written to the BMS and recorded in the audit log against your account.'}
            </Text>
          </View>

          <View style={[styles.ackRow, { borderColor: p.panelStitch }]}>
            <Text style={[T.rowLabel, { color: p.inkStrong, flex: 1 }]}>
              I understand the effect of this change
            </Text>
            <Switch
              value={acknowledged}
              onValueChange={setAcknowledged}
              accessibilityLabel="Acknowledge the effect of this change"
              trackColor={{ true: p.accent, false: p.panelTrack }}
              thumbColor={p.panelBase}
            />
          </View>

          <Text style={[T.sectionLabel, { color: p.inkFaint, marginTop: 20, marginBottom: 8 }]}>
            Reason {reasonRequired ? '(required)' : '(optional)'}
          </Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            multiline
            placeholder={
              reasonRequired
                ? 'Required for critical changes — who asked for this and why'
                : 'Optional note for the audit log'
            }
            placeholderTextColor={p.inkFaint}
            accessibilityLabel="Reason for this change"
            style={[
              T.body,
              styles.reason,
              { color: p.inkStrong, backgroundColor: p.panelAlt, borderColor: p.panelStitch },
            ]}
          />

          {stage === 'pin' && (
            <View style={[styles.pinCard, { backgroundColor: p.panelAlt }]}>
              <Text style={[T.sectionLabel, { color: p.inkFaint, textAlign: 'center' }]}>
                Enter your {PIN_DIGITS}-digit PIN
              </Text>
              <Text style={[T.caption, { color: p.inkSoft, textAlign: 'center', marginTop: 6 }]}>
                Confirming {fmt(current)} → {fmt(next)}
              </Text>

              <PinPad
                value={pin}
                onChange={(v) => {
                  setPin(v);
                  setPinError(null);
                }}
                onComplete={onPinComplete}
                disabled={lockoutSecondsLeft(lockedUntil) > 0}
              />

              <Text
                style={[
                  T.caption,
                  { color: pinError ? p.critical : p.inkFaint, textAlign: 'center', minHeight: 32 },
                ]}
              >
                {lockoutSecondsLeft(lockedUntil) > 0
                  ? `Locked for ${lockoutSecondsLeft(lockedUntil)}s after ${failedAttempts} failed attempts.`
                  : (pinError ?? ' ')}
              </Text>

              <PrimaryButton
                label="Cancel PIN entry"
                onPress={() => {
                  setStage('idle');
                  setPin('');
                  setPinError(null);
                }}
              />
            </View>
          )}

          {stage !== 'idle' && stage !== 'pin' && stage !== 'settled' && (
            <View style={{ marginTop: 18 }}>
              <StepList
                steps={[
                  { label: 'Write to BMS', done: stage !== 'writing', active: stage === 'writing' },
                  {
                    label: 'Read back value',
                    done: stage === 'auditing' || stage === 'done',
                    active: stage === 'reading',
                  },
                  { label: 'Record audit event', done: stage === 'done', active: stage === 'auditing' },
                ]}
              />
            </View>
          )}

          {error && (
            <View
              accessibilityRole="alert"
              style={[
                styles.notice,
                {
                  backgroundColor: p.panelAlt,
                  borderLeftColor:
                    outcome === 'adjusted'
                      ? p.warn
                      : outcome === 'timeout' || outcome === 'indeterminate'
                        ? p.warn
                        : p.critical,
                },
              ]}
            >
              <AlertTriangle
                size={15}
                color={outcome === 'rejected' || outcome === null ? p.critical : p.warn}
                strokeWidth={2.2}
              />
              <View style={{ flex: 1 }}>
                {outcome && (
                  <Text style={[T.tabLabel, { color: p.inkFaint, marginBottom: 4 }]}>
                    {OUTCOME_TITLE[outcome]}
                  </Text>
                )}
                <Text style={[T.caption, { color: p.inkStrong }]}>{error}</Text>
              </View>
            </View>
          )}

          {stage === 'settled' && (
            <View style={{ marginTop: 22 }}>
              <PrimaryButton label="Close" onPress={dismiss} />
              <Text style={[T.caption, { color: p.inkFaint, marginTop: 14, textAlign: 'center' }]}>
                {outcome === 'timeout' || outcome === 'indeterminate'
                  ? 'Re-read this parameter after reconnecting. Do not assume it changed, and do not assume it did not.'
                  : 'The recorded outcome is in Activity.'}
              </Text>
            </View>
          )}

          {stage !== 'pin' && stage !== 'settled' && (
            <View style={{ marginTop: 22 }}>
              <PrimaryButton
                label={
                  stage === 'done'
                    ? 'Written'
                    : pinRequired
                      ? `Write ${fmt(next)} — PIN required`
                      : `Write ${fmt(next)}`
                }
                onPress={submit}
                disabled={!ready}
                tone={critical ? 'critical' : 'default'}
              />
            </View>
          )}

          {stage !== 'pin' && stage !== 'settled' && (
            <Text style={[T.caption, { color: p.inkFaint, marginTop: 14, textAlign: 'center' }]}>
              {reasonRequired && !reason.trim()
                ? 'A reason is required before a critical parameter can be written.'
                : !acknowledged
                  ? 'Acknowledge the effect of the change to continue.'
                  : !changed
                    ? 'Adjust the value to enable the write.'
                    : pinRequired
                      ? 'Your PIN is requested before this change is sent.'
                      : 'The value is read back from the BMS after writing.'}
            </Text>
          )}
        </View>
      </ScrollView>
    </View>
  );
}


const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 22,
    paddingTop: 14,
    gap: 12,
  },
  levelRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 8 },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  compare: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 18,
    paddingTop: 22,
    paddingBottom: 18,
  },
  compareCell: { alignItems: 'center', minWidth: 96 },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, paddingBottom: 16 },
  stepBtn: {
    width: 48,
    height: 48,
    borderRadius: 14,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    minWidth: 128,
    height: 48,
    borderRadius: 14,
    borderWidth: 1.5,
    textAlign: 'center',
    paddingHorizontal: 12,
  },
  body: { paddingHorizontal: 20, paddingTop: 20 },
  notice: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    borderLeftWidth: 3,
    borderRadius: 12,
    padding: 13,
    marginBottom: 12,
  },
  ackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 15,
    paddingVertical: 12,
    marginTop: 8,
    minHeight: 56,
  },
  pinCard: { borderRadius: radii.card, padding: 16, marginTop: 20 },
  reason: {
    minHeight: 88,
    borderRadius: radii.card,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    textAlignVertical: 'top',
  },
});
