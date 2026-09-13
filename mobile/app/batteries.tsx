import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Building2, ChevronRight, Download, LifeBuoy, LogOut, Menu } from 'lucide-react-native';
import { useTheme } from '../src/theme/ThemeProvider';
import { APP_NAME } from '../src/brand';
import { space } from '../src/theme/tokens';
import { type as T } from '../src/theme/type';
import { Gauge } from '../src/gauge/Gauge';
import { LeatherPanel } from '../src/ui/LeatherPanel';
import { SectionLabel, StatusChip } from '../src/ui/primitives';
import { StepList } from '../src/ui/StepList';
import { SideMenu, type MenuItem } from '../src/ui/SideMenu';
import { useInstallPrompt } from '../src/pwa/install';
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
  const linkFailure = useSessionStore((s) => s.linkFailure);
  const role = useSessionStore((s) => s.role);
  const operator = useSessionStore((s) => s.operator);
  const signOut = useSessionStore((s) => s.signOut);
  const install = useInstallPrompt();
  const [menuOpen, setMenuOpen] = useState(false);

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

  /*
   * The only screen a technician has before a pack is linked, so it is the
   * only place they can sign out, get help, or install the app from until
   * then. Without this a technician at a company with no packs yet -- or one
   * whose packs are all out of range -- has no way out but the browser's
   * storage settings.
   */
  const menu: MenuItem[] = [
    ...(role === 'company'
      ? [
          {
            label: 'Your company',
            hint: 'People, fleet, gateways, the ledger',
            icon: <Building2 size={18} color={p.accent} strokeWidth={2.2} />,
            onPress: () => router.replace('/company'),
          },
        ]
      : []),
    {
      label: 'Help & safety',
      icon: <LifeBuoy size={18} color={p.accent} strokeWidth={2.2} />,
      onPress: () => router.push('/help'),
    },
    ...(install.kind === 'promptable'
      ? [
          {
            label: 'Install on this device',
            hint: 'Opens from the home screen, with or without signal',
            icon: <Download size={18} color={p.accent} strokeWidth={2.2} />,
            onPress: () => void install.install(),
          },
        ]
      : install.kind === 'manual'
        ? [{ label: 'Install on this device', hint: install.hint, onPress: () => undefined }]
        : []),
    {
      label: 'Sign out',
      hint: operator ?? undefined,
      icon: <LogOut size={18} color={p.critical} strokeWidth={2.2} />,
      onPress: () => signOut(),
    },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: p.panelBase }}>
      <LeatherPanel tone="hero" radius={0} style={{ paddingTop: topInset + 8, paddingBottom: 20 }}>
        <View style={[styles.head, styles.headRow]}>
          <View style={{ flexShrink: 1 }}>
            <Text style={[T.wordmark, { color: p.leatherInk, fontSize: 25 }]}>{APP_NAME}</Text>
            <Text style={[T.screenSub, { color: p.leatherInkSoft, marginTop: 6 }]}>
              {company} · {batteries.length} {batteries.length === 1 ? 'battery' : 'batteries'}
            </Text>
          </View>
          <Pressable
            onPress={() => setMenuOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Open menu"
            hitSlop={10}
            style={styles.menuButton}
          >
            <Menu size={20} color={p.leatherInk} strokeWidth={2.3} />
          </Pressable>
        </View>
      </LeatherPanel>


      <ScrollView
        contentContainerStyle={{ paddingHorizontal: space.gutter, paddingBottom: bottomInset + 28 }}
        showsVerticalScrollIndicator={false}
      >
        <SectionLabel>Your batteries</SectionLabel>

        {/*
          A failed link names the stage it failed at. "Could not connect" when
          the gateway answered and was refused sends a technician to check
          the wrong thing; the stage is the useful half of the message.
        */}
        {linkFailure ? (
          <View
            accessibilityRole="alert"
            style={[styles.failure, { backgroundColor: p.panelAlt, borderLeftColor: p.critical }]}
          >
            <Text style={[T.rowValue, { color: p.critical }]}>
              {linkFailure.stage === 'connecting'
                ? 'Could not connect to a gateway'
                : linkFailure.stage === 'authenticating'
                  ? 'Gateway not verified'
                  : 'Could not detect the BMS'}
            </Text>
            <Text style={[T.caption, { color: p.inkSoft, marginTop: 4 }]}>{linkFailure.message}</Text>
          </View>
        ) : null}

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

      {/* Last, so it paints over the list rather than under the cards. */}
      <SideMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title={company || APP_NAME}
        sub={operator ?? undefined}
        items={menu}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  head: { paddingHorizontal: 22, paddingTop: 12 },
  headRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  menuButton: { minWidth: 44, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' },
  // Tall in practice; declared so the 44pt guarantee is verifiable.
  card: { paddingHorizontal: 16, paddingVertical: 16, marginBottom: 10, minHeight: 44 },
  failure: { borderRadius: 16, padding: 14, marginBottom: 12, borderLeftWidth: 3 },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  dial: { width: 44, height: 36, justifyContent: 'center' },
  steps: { marginTop: 14, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, gap: 12 },
});
