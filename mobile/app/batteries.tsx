import React, { useEffect } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { useTheme } from '../src/theme/ThemeProvider';
import { space } from '../src/theme/tokens';
import { type as T } from '../src/theme/type';
import { Gauge } from '../src/gauge/Gauge';
import { LeatherPanel } from '../src/ui/LeatherPanel';
import { SectionLabel, StatusChip } from '../src/ui/primitives';
import { StepList } from '../src/ui/StepList';
import { useTelemetryStore } from '../src/store/useTelemetryStore';
import { CONNECT_STEPS, stepComplete, useSessionStore } from '../src/store/useSessionStore';
import { describeReading, useFleetStore } from '../src/store/useFleetStore';
import { useBottomInset, useTopInset } from '../src/ui/safeArea';



export default function Batteries() {
  const { p } = useTheme();
  const router = useRouter();
  const topInset = useTopInset();
  const bottomInset = useBottomInset();
  const snapshot = useTelemetryStore((s) => s.snapshot);

  const company = useSessionStore((s) => s.company);
  const batteries = useFleetStore((s) => s.batteries);
  const fleetStale = useFleetStore((s) => s.stale);
  const fleetError = useFleetStore((s) => s.error);
  const fleetLoading = useFleetStore((s) => s.loading);
  const hydrated = useFleetStore((s) => s.hydrated);
  const connect = useSessionStore((s) => s.connect);
  const stage = useSessionStore((s) => s.stage);
  const connectingId = useSessionStore((s) => s.connectingBatteryId);
  const connectedId = useSessionStore((s) => s.connectedBatteryId);

  useEffect(() => {
    const fleet = useFleetStore.getState();
    void fleet.hydrate().then(() => fleet.refresh());
  }, []);

  const onSelect = async (id: string) => {
    if (connectingId) return;
    if (id === connectedId) {
      router.replace('/(tabs)');
      return;
    }
    const ok = await connect(id);
    if (ok) router.replace('/(tabs)');
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.panelBase }}>
      <LeatherPanel tone="hero" radius={0} style={{ paddingTop: topInset + 8, paddingBottom: 20 }}>
        <View style={styles.head}>
          <Text style={[T.wordmark, { color: p.leatherInk, fontSize: 25 }]}>KnowyourEV</Text>
          <Text style={[T.screenSub, { color: p.leatherInkSoft, marginTop: 6 }]}>
            {company} · {batteries.length} {batteries.length === 1 ? 'battery' : 'batteries'}
          </Text>
        </View>
      </LeatherPanel>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: bottomInset + 28 }}
        showsVerticalScrollIndicator={false}
      >
        <SectionLabel>Your batteries</SectionLabel>

        {/*
          Nothing is shown that the server did not send. A technician hunting
          for a pack the app invented is worse off than one reading an honest
          empty screen.
        */}
        {hydrated && batteries.length === 0 && !fleetLoading && (
          <Text style={[T.caption, { color: p.inkFaint, marginHorizontal: 4, marginBottom: 12 }]}>
            {fleetError
              ? 'Could not load your batteries. Check your connection and pull to retry.'
              : 'No batteries are registered to your company yet.'}
          </Text>
        )}

        {fleetStale && batteries.length > 0 && (
          <Text style={[T.caption, { color: p.warn, marginHorizontal: 4, marginBottom: 10 }]}>
            Showing the last list retrieved — not confirmed with the server.
          </Text>
        )}

        {batteries.map((b) => {
          const isCurrent = connectedId === b.id;
          const linking = connectingId === b.id;

          // The live snapshot outranks a stored reading, but only for the pack
          // this phone is actually linked to.
          const stored = describeReading(b.lastReading);
          const soc = isCurrent && snapshot ? snapshot.soc : stored.soc;

          return (
            <Pressable
              key={b.id}
              onPress={() => onSelect(b.id)}
              // There is no "in range" or "offline" state here. Whether a pack
              // is reachable is a BLE fact this phone only learns by scanning,
              // and the server cannot know it. Every registered battery is
              // selectable; the connect sequence is what reports reachability.
              disabled={!!connectingId}
              accessibilityRole="button"
              accessibilityLabel={
                soc === null
                  ? `${b.serial}, state of charge unknown, never reported`
                  : `${b.serial}, ${Math.round(soc)} percent, ${
                      isCurrent && snapshot ? 'live' : stored.age
                    }`
              }
              style={({ pressed }) => ({
                opacity: connectingId && !linking ? 0.45 : pressed ? 0.75 : 1,
              })}
            >
              <LeatherPanel
                tone="panel"
                style={[styles.card, isCurrent && { borderWidth: 1.5, borderColor: p.accent }]}
              >
                <View style={styles.cardRow}>
                  <View style={styles.dial}>
                    <Gauge
                      variant="strip"
                      value={soc ?? 0}
                      min={0}
                      max={100}
                      major={25}
                      label={`${b.serial} state of charge`}
                      unit="%"
                      size={44}
                      stale={soc !== null && !(isCurrent && snapshot)}
                    />
                  </View>

                  <View style={{ flex: 1 }}>
                    <Text style={[T.rowValue, { color: p.inkStrong, fontSize: 15 }]}>
                      {b.serial}
                    </Text>
                    <Text style={[T.caption, { color: p.inkFaint, marginTop: 3 }]}>
                      {b.cellCount}S {b.chemistry}
                    </Text>
                  </View>

                  <View style={{ alignItems: 'flex-end', gap: 7 }}>
                    {/* The dial is decoration; this number is the reading. */}
                    <Text style={[T.metricValue, { color: p.inkStrong, fontSize: 20 }]}>
                      {soc === null ? '—' : `${Math.round(soc)}%`}
                    </Text>
                    {/* The age is not decoration: a bare number reads as current. */}
                    <StatusChip
                      tone={isCurrent ? 'good' : stored.tone}
                      label={
                        isCurrent ? (snapshot ? 'Linked · live' : 'Linked') : stored.age
                      }
                    />
                  </View>

                  <ChevronRight size={16} color={p.inkFaint} />
                </View>

                {/* Connect → Authenticate → Detect, in place on the selected pack. */}
                {linking && (
                  <View style={[styles.steps, { borderTopColor: p.panelStitch }]}>
                    <StepList
                      inset={false}
                      steps={CONNECT_STEPS.map((s) => ({
                        label: s.label,
                        done: stepComplete(stage, s.stage),
                        active: stage === s.stage,
                      }))}
                    />
                  </View>
                )}
              </LeatherPanel>
            </Pressable>
          );
        })}

        <Text style={[T.caption, { color: p.inkFaint, marginTop: 14, marginHorizontal: 4 }]}>
          Batteries registered to your company. A state of charge is shown with when it was
          last reported — only a pack this phone is linked to reads live. Connecting
          authenticates the gateway and detects the BMS before any telemetry is shown.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: 22, paddingTop: 12 },
  // Tall in practice; declared so the 44pt guarantee is verifiable.
  card: { paddingHorizontal: 16, paddingVertical: 16, marginBottom: 10, minHeight: 44 },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  dial: { width: 44, height: 36, justifyContent: 'center' },
  steps: { marginTop: 14, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, gap: 12 },
});
