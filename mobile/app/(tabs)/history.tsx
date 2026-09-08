import React, { useMemo, useState } from 'react';
import {
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { useTheme } from '../../src/theme/ThemeProvider';
import { type as T } from '../../src/theme/type';
import { LeatherPanel } from '../../src/ui/LeatherPanel';
import { ScreenScaffold } from '../../src/ui/ScreenScaffold';
import { DataRow, RowGroup, SectionLabel } from '../../src/ui/primitives';
import { useTelemetryStore, type HistoryPoint } from '../../src/store/useTelemetryStore';

type Metric = 'soc' | 'packVoltage' | 'packCurrent' | 'temp';

const METRICS: { key: Metric; label: string; unit: string; precision: number }[] = [
  { key: 'soc', label: 'SOC', unit: '%', precision: 0 },
  { key: 'packVoltage', label: 'Voltage', unit: 'V', precision: 1 },
  { key: 'packCurrent', label: 'Current', unit: 'A', precision: 0 },
  { key: 'temp', label: 'Temp', unit: '°C', precision: 1 },
];

/** The live BLE session holds this much; longer history comes from the cloud service. */
const RANGES = [
  { label: '30s', samples: 60 },
  { label: '1m', samples: 120 },
  { label: '2m', samples: 240 },
];

const CHART_H = 168;
const PAD = 16;

export default function History() {
  const { p } = useTheme();
  const history = useTelemetryStore((s) => s.history);
  const [metric, setMetric] = useState<Metric>('soc');
  const [range, setRange] = useState(1);
  const [width, setWidth] = useState(300);
  const [scrub, setScrub] = useState<number | null>(null);

  const spec = METRICS.find((m) => m.key === metric)!;
  const points: HistoryPoint[] = useMemo(
    () => history.slice(-RANGES[range].samples),
    [history, range]
  );

  const values = points.map((pt) => pt[metric]);
  const lo = values.length ? Math.min(...values) : 0;
  const hi = values.length ? Math.max(...values) : 1;
  const span = hi - lo || 1;
  const min = lo - span * 0.12;
  const max = hi + span * 0.12;

  const x = (i: number) =>
    PAD + (points.length > 1 ? i / (points.length - 1) : 0) * (width - PAD * 2);
  const y = (v: number) => CHART_H - PAD - ((v - min) / (max - min)) * (CHART_H - PAD * 2);

  const line = values.map((v, i) => `${i ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const area = values.length
    ? `${line} L ${x(values.length - 1).toFixed(1)} ${CHART_H - PAD} L ${PAD} ${CHART_H - PAD} Z`
    : '';

  const activeIndex = scrub ?? values.length - 1;
  const activeValue = values[activeIndex];
  const activePoint = points[activeIndex];

  const onScrub = (e: GestureResponderEvent) => {
    if (values.length < 2) return;
    const px = e.nativeEvent.locationX;
    const t = Math.max(0, Math.min(1, (px - PAD) / (width - PAD * 2)));
    setScrub(Math.round(t * (values.length - 1)));
  };

  const stats = useMemo(() => {
    if (!history.length) return null;
    const cur = history.map((h) => h.packCurrent);
    const temps = history.map((h) => h.temp);
    const maxCur = Math.max(...cur);
    const minCur = Math.min(...cur);
    return {
      // A buffer holding only charge current has no discharge peak, and vice
      // versa. Reporting Math.min regardless would label a charge current as a
      // discharge peak, which is worse than reporting nothing.
      peakCharge: maxCur > 0 ? maxCur : null,
      peakDischarge: minCur < 0 ? minCur : null,
      maxTemp: Math.max(...temps),
      samples: history.length,
    };
  }, [history]);

  return (
    <ScreenScaffold title="History" sub="Live session telemetry" back={false}>
      <View style={[styles.seg, { backgroundColor: p.panelAlt }]}>
        {METRICS.map((m) => {
          const on = m.key === metric;
          return (
            <Pressable
              key={m.key}
              onPress={() => {
                setMetric(m.key);
                setScrub(null);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={[styles.segItem, on && { backgroundColor: p.navPill }]}
            >
              <Text style={[T.tabLabel, { color: on ? p.navPillInk : p.inkFaint }]}>{m.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.ranges}>
        {RANGES.map((r, i) => {
          const on = i === range;
          return (
            <Pressable
              key={r.label}
              onPress={() => {
                setRange(i);
                setScrub(null);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={[
                styles.rangeChip,
                { borderColor: on ? p.accent : p.panelStitch },
                on && { backgroundColor: p.panelAlt },
              ]}
            >
              <Text style={[T.tabLabel, { color: on ? p.accent : p.inkFaint }]}>{r.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <LeatherPanel tone="panel" style={styles.chartCard}>
        <View
          onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={onScrub}
          onResponderMove={onScrub}
          onResponderRelease={() => setScrub(null)}
          accessibilityLabel={`${spec.label} trend chart`}
        >
          <Svg width={width} height={CHART_H}>
            {[0.25, 0.5, 0.75].map((f) => {
              const gy = CHART_H - PAD - f * (CHART_H - PAD * 2);
              return (
                <Line
                  key={f}
                  x1={PAD}
                  x2={width - PAD}
                  y1={gy}
                  y2={gy}
                  stroke={p.panelTrack}
                  strokeWidth={1}
                />
              );
            })}
            {area ? <Path d={area} fill={p.accent} opacity={0.1} /> : null}
            {line ? (
              <Path
                d={line}
                fill="none"
                stroke={p.accent}
                strokeWidth={2.4}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null}
            {activeValue !== undefined && (
              <>
                <Line
                  x1={x(activeIndex)}
                  x2={x(activeIndex)}
                  y1={PAD}
                  y2={CHART_H - PAD}
                  stroke={p.inkFaint}
                  strokeWidth={1}
                  opacity={scrub === null ? 0 : 0.5}
                />
                <Circle cx={x(activeIndex)} cy={y(activeValue)} r={8} fill={p.accent} opacity={0.2} />
                <Circle cx={x(activeIndex)} cy={y(activeValue)} r={4.5} fill={p.accent} />
              </>
            )}
          </Svg>
        </View>

        {/* A chart obeys the same rule as a gauge: no value without a number. */}
        <View style={styles.chartFoot}>
          <Text style={[T.caption, { color: p.inkFaint }]}>
            {scrub === null ? `−${RANGES[range].label}` : 'Scrubbing'}
          </Text>
          <View style={styles.chartReadout}>
            <Text testID="chart-readout" style={[T.rowValue, { color: p.inkStrong }]}>
              {`${activeValue !== undefined ? activeValue.toFixed(spec.precision) : '—'} ${spec.unit}`}
            </Text>
            {activePoint ? (
              <Text style={[T.caption, { color: p.inkFaint }]}>
                {new Date(activePoint.t).toLocaleTimeString()}
              </Text>
            ) : null}
          </View>
        </View>
      </LeatherPanel>

      <SectionLabel>Session summary</SectionLabel>
      <RowGroup tone="alt">
        <DataRow
          label="Peak charge current"
          value={stats?.peakCharge != null ? `+${stats.peakCharge.toFixed(0)} A` : 'none yet'}
        />
        <DataRow
          label="Peak discharge current"
          value={stats?.peakDischarge != null ? `${stats.peakDischarge.toFixed(0)} A` : 'none yet'}
        />
        <DataRow label="Max pack temperature" value={stats ? `${stats.maxTemp.toFixed(1)} °C` : '—'} />
        <DataRow label="Samples held" value={stats ? `${stats.samples}` : '0'} />
      </RowGroup>

      <Text style={[T.caption, { color: p.inkFaint, marginTop: 16, marginHorizontal: 4 }]}>
        Showing telemetry buffered during this BLE session. Longer trends come from the cloud
        telemetry history service once the battery is online.
      </Text>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  seg: { flexDirection: 'row', gap: 4, borderRadius: 999, padding: 3, marginTop: 18 },
  segItem: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 999, minHeight: 44, justifyContent: 'center' },
  ranges: { flexDirection: 'row', gap: 8, marginTop: 12 },
  rangeChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minHeight: 44,
    justifyContent: 'center',
  },
  chartCard: { marginTop: 14, paddingHorizontal: 14, paddingTop: 18, paddingBottom: 14 },
  chartReadout: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  chartFoot: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
});
