import React from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../src/theme/ThemeProvider';
import { APP_NAME } from '../src/brand';
import { dangerColor, radii } from '../src/theme/tokens';
import { type as T } from '../src/theme/type';
import { ScreenScaffold } from '../src/ui/ScreenScaffold';
import { PrimaryButton, SectionLabel, StatusChip } from '../src/ui/primitives';
import { exportAudit, pendingSync } from '../src/store/auditStorage';
import { useSessionStore } from '../src/store/useSessionStore';
import { SOURCE_LABEL, useActivityStore } from '../src/store/useActivityStore';

function when(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

/**
 * Write history. `source` is the field that answers "who actually initiated
 * this" — admin remote writes reach the hardware without ever prompting the
 * person standing next to it, so this timeline is their only record.
 */
export default function Activity() {
  const { p } = useTheme();
  const entries = useActivityStore((s) => s.entries);
  const droppedCount = useActivityStore((s) => s.droppedCount);
  const dismiss = useActivityStore((s) => s.dismissBanner);
  const battery = useSessionStore((s) => s.connectedBatteryId);
  const operator = useSessionStore((s) => s.operator);

  const unsynced = pendingSync({ entries, droppedCount });

  const onExport = () =>
    Share.share({
      title: `${APP_NAME} write history`,
      message: exportAudit(
        { entries, droppedCount },
        { battery: battery ?? 'unknown', operator: operator ?? 'unknown' }
      ),
    });

  React.useEffect(() => dismiss(), [dismiss]);

  return (
    <ScreenScaffold title="Activity" sub="Write history · this battery">
      <View style={[styles.ledger, { backgroundColor: p.panelAlt }]}>
        <Text style={[T.caption, { color: p.inkSoft, flex: 1 }]}>
          {unsynced.length > 0
            ? `${unsynced.length} of ${entries.length} entries are held on this device and not yet in the audit ledger.`
            : `${entries.length} entries, all recorded.`}
          {droppedCount > 0
            ? ` ${droppedCount} older ${droppedCount === 1 ? 'entry has' : 'entries have'} been dropped to stay within local storage.`
            : ''}
        </Text>
      </View>

      <SectionLabel>All writes</SectionLabel>
      {entries.map((e) => {
        const admin = e.source !== 'local';
        const rail = e.dangerLevel === 'Critical' && admin ? p.critical : admin ? p.accent : p.panelStitch;
        return (
          <View
            key={e.id}
            style={[styles.card, { backgroundColor: p.panelAlt, borderLeftColor: rail }]}
          >
            <View style={styles.top}>
              <Text style={[T.rowLabel, { color: p.inkStrong, flex: 1 }]}>{e.displayName}</Text>
              <StatusChip
                tone={
                  e.result === 'success'
                    ? 'good'
                    : e.result === 'rejected'
                      ? 'critical'
                      : e.result === 'adjusted'
                        ? 'warn'
                        : 'neutral'
                }
                label={e.result === 'indeterminate' ? 'unknown' : e.result}
              />
            </View>

            <Text style={[T.rowValue, { color: p.inkSoft, marginTop: 8 }]}>
              {e.oldValue} → <Text style={{ color: p.inkStrong }}>{e.newValue}</Text>
            </Text>

            <View style={styles.meta}>
              <View style={[styles.badge, { borderColor: admin ? p.accent : p.panelStitch }]}>
                <Text style={[T.tabLabel, { color: admin ? p.accent : p.inkFaint, fontSize: 8.5 }]}>
                  {SOURCE_LABEL[e.source]}
                </Text>
              </View>
              <View style={[styles.dot, { backgroundColor: dangerColor(p, e.dangerLevel) }]} />
              <Text style={[T.caption, { color: p.inkFaint, flex: 1 }]}>
                {e.actor} · {when(e.timestamp)}
                {e.supportSessionId ? ` · ${e.supportSessionId}` : ''}
              </Text>
            </View>

            {e.reason && (
              <Text style={[T.caption, { color: p.inkSoft, marginTop: 8, fontStyle: 'italic' }]}>
                “{e.reason}”
              </Text>
            )}
          </View>
        );
      })}

      <View style={{ marginTop: 18 }}>
        <PrimaryButton label="Export write history" onPress={onExport} />
      </View>

      <Text style={[T.caption, { color: p.inkFaint, marginTop: 12, marginHorizontal: 4 }]}>
        Every attempt is recorded, not only the ones that succeeded. An entry marked{' '}
        <Text style={{ color: p.inkStrong }}>unknown</Text> means the link dropped or the BMS never
        answered — the parameter may or may not have changed, and re-reading it is the only way to
        know.
      </Text>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  card: { borderLeftWidth: 3, borderRadius: radii.card, padding: 16, marginBottom: 10 },
  ledger: { flexDirection: 'row', borderRadius: radii.card, padding: 14, marginTop: 18 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  badge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 3 },
  dot: { width: 6, height: 6, borderRadius: 99 },
});
