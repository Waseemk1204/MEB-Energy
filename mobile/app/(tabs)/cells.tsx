import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../src/theme/ThemeProvider';
import { type as T } from '../../src/theme/type';
import { LeatherPanel } from '../../src/ui/LeatherPanel';
import { ScreenScaffold } from '../../src/ui/ScreenScaffold';
import { DataRow, RowGroup, SectionLabel } from '../../src/ui/primitives';
import { useTelemetryStore } from '../../src/store/useTelemetryStore';
import { useSettingsStore } from '../../src/store/useSettingsStore';
import { parameterFor, profile } from '../../src/bms/capabilityProfile';

/**
 * Per-cell detail. No gauges: detail data stays tabular, where it is legible
 * and comparable across 24 values.
 */
export default function Cells() {
  const { p } = useTheme();
  const snapshot = useTelemetryStore((s) => s.snapshot);
  const values = useSettingsStore((s) => s.values);

  const deltaLimit = values['balance_delta_mv'] ?? parameterFor('balance_delta_mv')?.value ?? 15;
  const balanceStart = values['balance_start_v'] ?? parameterFor('balance_start_v')?.value ?? 3.4;

  if (!snapshot) return <View style={{ flex: 1, backgroundColor: p.panelBase }} />;

  const overDelta = snapshot.deltaMv > deltaLimit;

  return (
    <ScreenScaffold
      title="Cells"
      sub={`${profile.cellCount}S · ${profile.bmsModel}`}
      back={false}
    >
      <View style={styles.grid}>
        {snapshot.cellVoltages.map((v, i) => {
          const isMin = v === snapshot.minCellV;
          const isMax = v === snapshot.maxCellV;
          const edge = isMin || isMax;
          return (
            <LeatherPanel
              key={i}
              tone="panel"
              radius={15}
              style={[
                styles.cell,
                edge && { borderWidth: 1.5, borderColor: p.accent },
              ]}
            >
              <Text style={[T.tabLabel, { color: p.inkFaint, fontSize: 9.5 }]}>CELL {i + 1}</Text>
              <Text style={[T.rowValue, { color: p.inkStrong, fontSize: 15, marginTop: 5 }]}>
                {v.toFixed(3)}
              </Text>
              <Text style={[T.tabLabel, { color: p.accent, fontSize: 8, marginTop: 4, height: 10 }]}>
                {edge ? (isMax ? 'MAX' : 'MIN') : ''}
              </Text>
            </LeatherPanel>
          );
        })}
      </View>

      <SectionLabel>Balance</SectionLabel>
      <RowGroup tone="alt">
        <DataRow
          label="Delta"
          value={`${snapshot.deltaMv.toFixed(0)} mV`}
          level={overDelta ? 'Warning' : 'Normal'}
        />
        <DataRow label="Balance opening delta" value={`${deltaLimit} mV`} />
        <DataRow label="Balance turn-on voltage" value={`${balanceStart.toFixed(3)} V`} />
        <DataRow
          label="Balancing"
          value={snapshot.balancing ? `Active · ${snapshot.balancingCells.length} cells` : 'Idle'}
        />
      </RowGroup>

      <Text style={[T.caption, { color: p.inkFaint, marginTop: 16, marginHorizontal: 4 }]}>
        {overDelta
          ? `Delta is above the ${deltaLimit} mV balance threshold. Balancing engages above ${balanceStart.toFixed(3)} V per cell.`
          : `Delta is within the ${deltaLimit} mV balance threshold.`}
      </Text>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, paddingTop: 18 },
  cell: {
    width: '31.5%',
    paddingVertical: 13,
    paddingHorizontal: 4,
    alignItems: 'center',
  },
});
