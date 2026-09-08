import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../src/theme/ThemeProvider';
import { radii } from '../src/theme/tokens';
import { type as T } from '../src/theme/type';
import { ScreenScaffold } from '../src/ui/ScreenScaffold';
import { DataRow, RowGroup, SectionLabel } from '../src/ui/primitives';
import { SOURCE_LABEL, useActivityStore } from '../src/store/useActivityStore';
import { useSessionStore } from '../src/store/useSessionStore';
import { formatStarted } from '../src/api/supportSessions';
import { useSupportStore } from '../src/store/useSupportStore';

/**
 * Read-only by design. There is deliberately no approve/deny control: an admin
 * remote write never asks the user for permission (PRD §6.3 step 7). What the
 * user gets instead is complete visibility — who, when, and what changed.
 *
 * Everything here comes from the server. It used to be fabricated: a session
 * id, an administrator's name, "started 4 minutes ago" and a pulsing *Live*
 * indicator, none of which corresponded to anything. Somebody reading it would
 * have believed an administrator was in a session with the pack beside them at
 * that moment.
 */
export default function SupportSession() {
  const { p } = useTheme();
  const entries = useActivityStore((s) => s.entries);
  const batteryId = useSessionStore((s) => s.connectedBatteryId);
  const company = useSessionStore((s) => s.company);

  // The same state the Dashboard row reads. Two screens showing this must not
  // be able to disagree, which is exactly what they did when both invented it.
  const state = useSupportStore((s) => s.state);

  const reduceMotion = useReducedMotion();
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (reduceMotion) return;
    pulse.value = withRepeat(withTiming(0.35, { duration: 900 }), -1, true);
  }, [pulse, reduceMotion]);

  useEffect(() => {
    void useSupportStore.getState().refresh(batteryId);
  }, [batteryId]);

  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));
  const active = state.kind === 'active' ? state.session : null;

  const sessionActions = active
    ? entries.filter((e) => e.supportSessionId === active.id)
    : [];

  return (
    <ScreenScaffold
      title="Support"
      sub={
        state.kind === 'unchecked'
          ? 'Checking…'
          : active
            ? `Session open · started ${formatStarted(active.startedAt)}`
            : state.kind === 'unreachable'
              ? 'Could not check'
              : 'No session open'
      }
      right={
        // The live indicator appears only when something actually is.
        active ? (
          <View style={styles.live}>
            <Animated.View style={[styles.pulse, { backgroundColor: p.accent }, pulseStyle]} />
            <Text style={[T.tabLabel, { color: p.leatherInkSoft }]}>Live</Text>
          </View>
        ) : undefined
      }
    >
      {active ? (
        <>
          <SectionLabel>Session</SectionLabel>
          <RowGroup tone="alt">
            <DataRow label="Session ID" value={active.id.slice(0, 8)} />
            <DataRow label="Company" value={company} />
            <DataRow label="Battery" value={batteryId ?? 'None'} />
            <DataRow label="Started" value={formatStarted(active.startedAt)} />
          </RowGroup>

          <SectionLabel>Changes this session</SectionLabel>
          {sessionActions.length ? (
            <RowGroup tone="alt">
              {sessionActions.map((e) => (
                <DataRow
                  key={e.id}
                  label={e.displayName}
                  value={`${e.oldValue} → ${e.newValue}`}
                  level={e.dangerLevel}
                />
              ))}
            </RowGroup>
          ) : (
            <View style={[styles.empty, { backgroundColor: p.panelAlt }]}>
              <Text style={[T.caption, { color: p.inkSoft }]}>
                Nothing has been changed in this session.
              </Text>
            </View>
          )}
        </>
      ) : (
        <View style={[styles.empty, { backgroundColor: p.panelAlt }]}>
          <Text style={[T.caption, { color: p.inkSoft }]}>
            {state.kind === 'unchecked'
              ? 'Checking for an open support session…'
              : state.kind === 'unreachable'
                ? 'Could not reach knowyourEV to check for a support session. This does not mean there is none.'
                : batteryId
                  ? 'No administrator has an open session with this battery.'
                  : 'Connect to a battery to see whether a support session is open.'}
          </Text>
        </View>
      )}

      <View style={[styles.note, { backgroundColor: p.panelAlt, borderLeftColor: p.accent }]}>
        <Text style={[T.caption, { color: p.inkSoft }]}>
          An administrator can only reach this battery while your Bluetooth session is active. If
          you disconnect, or move out of range, commands stop at the cloud and are never delivered
          to the BMS. Changes appear here and in Activity tagged{' '}
          <Text style={{ color: p.inkStrong }}>{SOURCE_LABEL.admin_remote}</Text>.
        </Text>
      </View>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  live: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  pulse: { width: 8, height: 8, borderRadius: 99 },
  empty: { borderRadius: radii.card, padding: 16 },
  note: { borderLeftWidth: 3, borderRadius: radii.card, padding: 16, marginTop: 20 },
});
