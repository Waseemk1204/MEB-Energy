import React, { useEffect } from 'react';
import { Dimensions, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { BatteryMedium, ChevronLeft, MapPin, Zap } from 'lucide-react-native';

import { useTheme } from '../../src/theme/ThemeProvider';
import { radii, space } from '../../src/theme/tokens';
import { type as T } from '../../src/theme/type';
import { Gauge } from '../../src/gauge/Gauge';
import { LeatherPanel } from '../../src/ui/LeatherPanel';
import {
  DataRow,
  FactStrip,
  RowGroup,
  SectionLabel,
  StatusChip,
} from '../../src/ui/primitives';
import { PassiveChangeBanner } from '../../src/ui/PassiveChangeBanner';
import { StaleBanner } from '../../src/ui/StaleBanner';
import { useFreshness } from '../../src/telemetry/freshness';
import { useActivityStore } from '../../src/store/useActivityStore';
import { useSessionStore } from '../../src/store/useSessionStore';
import { describeSupport, useSupportStore } from '../../src/store/useSupportStore';
import { useTelemetryStore } from '../../src/store/useTelemetryStore';
import { axes, profile } from '../../src/bms/capabilityProfile';
import { useTopInset } from '../../src/ui/safeArea';

const BATTERY_ID = 'BAT-00042';
const COMPANY = 'Aurora Fleet';

export default function Dashboard() {
  const { p } = useTheme();
  const router = useRouter();
  // Only the top edge: the tab bar takes layout space, so the bottom is already
  // clear without this screen padding for it.
  const topInset = useTopInset();
  const snapshot = useTelemetryStore((s) => s.snapshot);
  const batteryId = useSessionStore((s) => s.connectedBatteryId);
  const writeCount = useActivityStore((s) => s.entries.length);
  const supportState = useSupportStore((s) => s.state);

  // Checked when the screen opens and whenever the linked pack changes, so the
  // row reflects this battery rather than the last one.
  useEffect(() => {
    void useSupportStore.getState().refresh(batteryId);
  }, [batteryId]);
  const freshness = useFreshness(snapshot?.timestamp);
  const a = axes();

  if (!snapshot) {
    return <View style={{ flex: 1, backgroundColor: p.panelBase }} />;
  }

  const heroSize = Math.min(Dimensions.get('window').width - 96, 262);
  const temp = snapshot.temperatures[0] ?? 0;
  const chargeState =
    snapshot.packCurrent > 3 ? 'Charging' : snapshot.packCurrent < -3 ? 'Discharging' : 'Idle';
  const critical = snapshot.faults.filter((f) => f.level === 'Critical');

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: p.panelBase }}
      contentContainerStyle={{ paddingBottom: 28 }}
      showsVerticalScrollIndicator={false}
    >
      {/* ---- leather hero: bleeds to the top edge, holds the one hero gauge ---- */}
      <LeatherPanel tone="hero" radius={0} style={{ paddingTop: topInset + 8, paddingBottom: 28 }}>
        <View style={styles.header}>
          <View style={{ flexShrink: 1 }}>
            {/*
             * The way back to the battery list.
             *
             * Choosing a pack used to be one-way: every other screen has a
             * Back, but the Dashboard is the top of its own stack, so the only
             * route back to the list was a row buried in Settings. Somebody
             * who picked the wrong pack had no way to say so.
             *
             * `replace` rather than `push` because this is leaving the pack,
             * not stacking a screen over it — pushing would leave the old
             * battery's Dashboard underneath, reachable by a system back
             * gesture, showing readings for a pack the user has left.
             */}
            <Pressable
              onPress={() => router.replace('/batteries')}
              accessibilityRole="button"
              accessibilityLabel="Back to batteries"
              hitSlop={12}
              style={styles.back}
            >
              <ChevronLeft size={16} color={p.leatherInkSoft} strokeWidth={2.4} />
              <Text style={[T.tabLabel, { color: p.leatherInkSoft }]}>Batteries</Text>
            </Pressable>
            <Text style={[T.screenTitle, { color: p.leatherInk }]}>{COMPANY}</Text>
            <Text style={[T.screenSub, { color: p.leatherInkSoft, marginTop: 7 }]}>
              {BATTERY_ID} · {profile.cellCount}S {profile.chemistry}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <View style={[styles.socChip, { borderColor: p.leatherInk }]}>
              <BatteryMedium size={14} color={p.leatherInk} strokeWidth={2.2} />
              <Text style={[T.rowValue, { color: p.leatherInk, fontSize: 13 }]}>
                {Math.round(snapshot.soc)}%
              </Text>
            </View>
            <Text style={[T.tabLabel, { color: p.leatherInkSoft, marginTop: 7 }]}>
              Cycles {snapshot.cycles}
            </Text>
          </View>
        </View>

        <View style={{ alignItems: 'center' }}>
          <Gauge
            variant="hero"
            value={snapshot.soc}
            min={a.soc.min}
            max={a.soc.max}
            major={a.soc.major}
            minor={a.soc.minor}
            dangerZone={a.soc.dangerZone}
            label="SOC"
            unit="%"
            size={heroSize}
            stale={freshness.stale}
          />
        </View>
      </LeatherPanel>

      {/* ---- cream panel: hard material seam against the leather ---- */}
      <View style={[styles.cream, { backgroundColor: p.panelBase, shadowColor: p.panelShadow }]}>
        <View style={styles.metrics}>
          <Gauge
            variant="metric"
            value={snapshot.packCurrent}
            min={a.packCurrent.min}
            max={a.packCurrent.max}
            major={a.packCurrent.major}
            bipolar
            label="Pack Current"
            unit="A"
            format={(v) => `${v > 0 ? '+' : ''}${Math.round(v)}`}
            formatTick={(v) => (v === 0 ? '0' : `${v > 0 ? '+' : ''}${v}`)}
            glyph={<Zap size={17} color={p.accent} strokeWidth={2.2} opacity={0.7} />}
            stale={freshness.stale}
          />
          <Gauge
            variant="metric"
            value={snapshot.packVoltage}
            min={a.packVoltage.min}
            max={a.packVoltage.max}
            major={a.packVoltage.major}
            label="Pack Voltage"
            unit="V"
            format={(v) => v.toFixed(1)}
            glyph={<BatteryMedium size={17} color={p.accent} strokeWidth={2.2} opacity={0.7} />}
            stale={freshness.stale}
          />
        </View>

        <View style={[styles.divider, { backgroundColor: p.panelStitch }]} />

        <FactStrip
          facts={[
            { label: 'Battery health', value: `${snapshot.soh}%`, sub: 'Good', tone: 'good' },
            {
              label: 'Temp',
              value: `${Math.round(temp)}°C`,
              sub: `${Math.round(temp * 1.8 + 32)}°F`,
            },
            {
              label: 'Charging',
              value: freshness.stale ? 'Unknown' : chargeState,
              sub: freshness.stale ? 'no live data' : snapshot.bmsModel,
              tone: freshness.stale ? 'critical' : undefined,
            },
          ]}
        />
      </View>

      <StaleBanner freshness={freshness} />

      <PassiveChangeBanner />

      {/* Somebody else may have just used this account. Shown after the live
          data warnings, which are about the pack in front of you. */}

      <View style={{ paddingHorizontal: space.gutter }}>
        <SectionLabel>Pack detail</SectionLabel>
        <RowGroup tone="alt">
          <DataRow label="Cell delta" value={`${snapshot.deltaMv.toFixed(0)} mV`} />
          <DataRow
            label="Min / max cell"
            value={`${snapshot.minCellV.toFixed(3)} / ${snapshot.maxCellV.toFixed(3)} V`}
          />
          <DataRow
            label="Charge MOS"
            trailing={<StatusChip tone={snapshot.chargeMos ? 'good' : 'critical'} label={snapshot.chargeMos ? 'On' : 'Off'} />}
          />
          <DataRow
            label="Discharge MOS"
            trailing={<StatusChip tone={snapshot.dischargeMos ? 'good' : 'critical'} label={snapshot.dischargeMos ? 'On' : 'Off'} />}
          />
          <DataRow label="Balancing" value={snapshot.balancing ? `Active · ${snapshot.balancingCells.length} cells` : 'Idle'} />
        </RowGroup>

        <SectionLabel>Battery</SectionLabel>
        <RowGroup>
          <DataRow
            label="Protection"
            value={
              critical.length
                ? `${critical.length} active fault${critical.length > 1 ? 's' : ''}`
                : snapshot.faults.length
                  ? `${snapshot.faults.length} warning`
                  : 'No active faults'
            }
            level={critical.length ? 'Critical' : snapshot.faults.length ? 'Warning' : 'Normal'}
            onPress={() => router.push('/protection')}
          />
          <DataRow label="Cell voltages" value={`${snapshot.cellCount}S`} onPress={() => router.push('/cells')} />
          <DataRow label="BMS information" value={snapshot.bmsModel} onPress={() => router.push('/bms-info')} />
          {/*
            All three read real state. They used to be literals — an invented
            gateway serial, a hardcoded write count, and "SS-4471 active"
            asserting a live support session on the screen a technician looks
            at most.
          */}
          <DataRow
            label="Device"
            value={batteryId ?? 'Not connected'}
            onPress={() => router.push('/device')}
          />
          <DataRow
            label="Activity"
            value={`${writeCount} ${writeCount === 1 ? 'change' : 'changes'}`}
            onPress={() => router.push('/activity')}
          />
          <DataRow
            label="Support session"
            value={describeSupport(supportState)}
            onPress={() => router.push('/support-session')}
          />
          <DataRow label="Help & safety" onPress={() => router.push('/help')} />
        </RowGroup>

        {/* Reserved per PRD §7.16 — shipped disabled, never omitted. */}
        <SectionLabel>Location</SectionLabel>
        <View style={[styles.locate, { backgroundColor: p.panelAlt }]}>
          <MapPin size={16} color={p.inkFaint} strokeWidth={2} />
          <Text style={[T.caption, { color: p.inkFaint, flex: 1 }]}>
            Location unavailable — requires GPS-enabled hardware.
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // 44pt minimum declared outright rather than relying on content plus hitSlop.
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    minHeight: 44,
    marginLeft: -4,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 24,
    paddingTop: 10,
    paddingBottom: 14,
    gap: 12,
  },
  socChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1.5,
    borderRadius: 7,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  cream: {
    borderTopLeftRadius: radii.panel,
    borderTopRightRadius: radii.panel,
    marginTop: -2,
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 1,
    shadowRadius: 24,
  },
  metrics: { flexDirection: 'row', justifyContent: 'space-around', paddingTop: 20, paddingBottom: 6 },
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 22 },
  locate: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
    opacity: 0.75,
  },
});
