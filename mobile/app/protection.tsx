import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ShieldCheck } from 'lucide-react-native';
import { useTheme } from '../src/theme/ThemeProvider';
import { dangerColor, radii } from '../src/theme/tokens';
import { type as T } from '../src/theme/type';
import { ScreenScaffold } from '../src/ui/ScreenScaffold';
import { DataRow, RowGroup, SectionLabel, StatusChip } from '../src/ui/primitives';
import { useTelemetryStore } from '../src/store/useTelemetryStore';

export default function Protection() {
  const { p } = useTheme();
  const snapshot = useTelemetryStore((s) => s.snapshot);
  if (!snapshot) return <View style={{ flex: 1, backgroundColor: p.panelBase }} />;

  return (
    <ScreenScaffold title="Protection" sub={`${snapshot.bmsModel} · live state`}>
      <SectionLabel>Active faults</SectionLabel>
      {snapshot.faults.length === 0 ? (
        <View style={[styles.card, { backgroundColor: p.panelAlt, borderLeftColor: p.good }]}>
          <ShieldCheck size={18} color={p.good} strokeWidth={2.2} />
          <View style={{ flex: 1 }}>
            <Text style={[T.rowLabel, { color: p.inkStrong }]}>No active faults</Text>
            <Text style={[T.caption, { color: p.inkSoft, marginTop: 3 }]}>
              All protection thresholds are within limits.
            </Text>
          </View>
        </View>
      ) : (
        snapshot.faults.map((f) => (
          <View
            key={f.code}
            style={[
              styles.card,
              { backgroundColor: p.panelAlt, borderLeftColor: dangerColor(p, f.level) },
            ]}
          >
            <View style={{ flex: 1 }}>
              <View style={styles.faultHead}>
                <Text style={[T.rowLabel, { color: p.inkStrong }]}>{f.label}</Text>
                <StatusChip tone={f.level === 'Critical' ? 'critical' : 'warn'} label={f.level} />
              </View>
              {/* The triggering value is printed, never left to the reader to infer. */}
              {f.detail && (
                <Text style={[T.rowValue, { color: p.inkSoft, marginTop: 6 }]}>{f.detail}</Text>
              )}
            </View>
          </View>
        ))
      )}

      <SectionLabel>MOS state</SectionLabel>
      <View style={styles.mosRow}>
        <MosTile label="Charge" on={snapshot.chargeMos} />
        <MosTile label="Discharge" on={snapshot.dischargeMos} />
      </View>

      <SectionLabel>Balancing</SectionLabel>
      <RowGroup tone="alt">
        <DataRow label="State" value={snapshot.balancing ? 'Active' : 'Idle'} />
        <DataRow label="Cells balancing" value={`${snapshot.balancingCells.length}`} />
        <DataRow label="Cell delta" value={`${snapshot.deltaMv.toFixed(0)} mV`} />
      </RowGroup>
    </ScreenScaffold>
  );
}

function MosTile({ label, on }: { label: string; on: boolean }) {
  const { p } = useTheme();
  return (
    <View style={[styles.mos, { backgroundColor: p.panelAlt }]}>
      <Text style={[T.metricCaption, { color: p.inkFaint }]}>{label} MOS</Text>
      <Text style={[T.metricValue, { color: on ? p.good : p.critical, fontSize: 28, marginTop: 8 }]}>
        {on ? 'ON' : 'OFF'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
    borderLeftWidth: 3,
    borderRadius: radii.card,
    padding: 16,
    marginBottom: 10,
  },
  faultHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  mosRow: { flexDirection: 'row', gap: 10 },
  mos: { flex: 1, borderRadius: radii.card, paddingVertical: 20, alignItems: 'center' },
});
