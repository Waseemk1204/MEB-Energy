import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Check, Minus } from 'lucide-react-native';
import { useTheme } from '../src/theme/ThemeProvider';
import { type as T } from '../src/theme/type';
import { ScreenScaffold } from '../src/ui/ScreenScaffold';
import { DataRow, RowGroup, SectionLabel } from '../src/ui/primitives';
import { LeatherPanel } from '../src/ui/LeatherPanel';
import { profile } from '../src/bms/capabilityProfile';
import { useTelemetryStore } from '../src/store/useTelemetryStore';

/**
 * The screen that makes the vendor-neutral claim visible: everything below is
 * read from the capability profile, so a second BMS vendor changes this page
 * without changing this file.
 */
export default function BmsInfo() {
  const { p } = useTheme();
  const snapshot = useTelemetryStore((s) => s.snapshot);

  return (
    <ScreenScaffold title="BMS" sub="Model, firmware and capabilities">
      <SectionLabel>Identity</SectionLabel>
      <RowGroup tone="alt">
        <DataRow label="Model" value={profile.bmsModel} />
        <DataRow label="Vendor" value={profile.vendor} />
        <DataRow label="Firmware" value={snapshot?.bmsFirmware ?? profile.firmware} />
        <DataRow label="Protocol" value={profile.protocol} />
      </RowGroup>

      <SectionLabel>Pack</SectionLabel>
      <RowGroup tone="alt">
        <DataRow label="Chemistry" value={profile.chemistry} />
        <DataRow label="Series cells" value={`${profile.cellCount}S`} />
        <DataRow label="Nominal capacity" value={`${profile.capacityAh} Ah`} />
        <DataRow label="Continuous current" value={`${profile.continuousCurrentA} A`} />
      </RowGroup>

      <SectionLabel>Capability matrix</SectionLabel>
      <LeatherPanel tone="panel" style={styles.matrix}>
        <View style={[styles.mrow, styles.mhead, { borderBottomColor: p.panelStitch }]}>
          <Text style={[T.tabLabel, { color: p.inkFaint, flex: 1 }]}>Parameter</Text>
          <Text style={[T.tabLabel, { color: p.inkFaint, width: 34, textAlign: 'center' }]}>R</Text>
          <Text style={[T.tabLabel, { color: p.inkFaint, width: 34, textAlign: 'center' }]}>W</Text>
          <Text style={[T.tabLabel, { color: p.inkFaint, width: 46, textAlign: 'center' }]}>Admin</Text>
        </View>
        {profile.parameters.map((param, i) => (
          <View
            key={param.parameter_key}
            style={[
              styles.mrow,
              i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.panelStitch },
            ]}
          >
            <Text style={[T.caption, { color: p.inkStrong, flex: 1 }]} numberOfLines={1}>
              {param.display_name}
            </Text>
            <Tick on={param.readable} />
            <Tick on={param.writable} />
            <Tick on={param.requires_admin} width={46} />
          </View>
        ))}
      </LeatherPanel>

      <Text style={[T.caption, { color: p.inkFaint, marginTop: 16, marginHorizontal: 4 }]}>
        {profile.parameters.length} parameters in this capability profile ·{' '}
        {profile.parameters.filter((x) => x.writable).length} writable. The app holds no
        vendor-specific logic; a new BMS ships as another profile.
      </Text>
    </ScreenScaffold>
  );
}

function Tick({ on, width = 34 }: { on: boolean; width?: number }) {
  const { p } = useTheme();
  return (
    <View style={{ width, alignItems: 'center' }}>
      {on ? (
        <Check size={14} color={p.good} strokeWidth={2.6} />
      ) : (
        <Minus size={14} color={p.inkFaint} strokeWidth={2.2} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  matrix: { paddingVertical: 4 },
  mrow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 15, paddingVertical: 11, gap: 8 },
  mhead: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 10 },
});
