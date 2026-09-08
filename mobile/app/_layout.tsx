import React, { useEffect } from 'react';
import { View } from 'react-native';
import { Stack, useRootNavigationState, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import {
  SpaceGrotesk_500Medium,
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
} from '@expo-google-fonts/space-grotesk';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import { Fraunces_600SemiBold } from '@expo-google-fonts/fraunces';

import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';
import { useTelemetryStore } from '../src/store/useTelemetryStore';
import { useSessionStore } from '../src/store/useSessionStore';
import { useSecurityStore } from '../src/store/useSecurityStore';
import { useActivityStore } from '../src/store/useActivityStore';
import { ErrorBoundary } from '../src/ui/ErrorBoundary';
import { entryRoute } from '../src/navigation/entryRoute';

/**
 * Enforces the PRD §7.4 entry flow:
 *   unauthenticated        → Login
 *   authenticated, no link → Battery List
 *   linked                 → the app
 *
 * Battery List stays reachable while connected so a user can switch packs;
 * only Login is closed off once signed in.
 */
function useEntryFlow() {
  const segments = useSegments();
  const router = useRouter();
  const hydrated = useSessionStore((s) => s.hydrated);
  const authenticated = useSessionStore((s) => s.authenticated);
  const connectedBatteryId = useSessionStore((s) => s.connectedBatteryId);
  // The navigator must exist before any replace(), or the first one is dropped.
  // This stays undefined until the root navigator is mounted, which avoids
  // tracking readiness with a setState inside an effect.
  const navigationState = useRootNavigationState();
  const navigatorReady = !!navigationState?.key;

  useEffect(() => {
    // Routing before the stored session is read would flash Login at a user
    // who is already signed in.
    if (!navigatorReady || !hydrated) return;

    const target = entryRoute({
      authenticated,
      connectedBatteryId,
      segment: segments[0],
    });
    if (target) router.replace(target as Parameters<typeof router.replace>[0]);
  }, [navigatorReady, hydrated, segments, authenticated, connectedBatteryId, router]);
}

function Shell() {
  const { p, mode } = useTheme();
  const connectedBatteryId = useSessionStore((s) => s.connectedBatteryId);
  const connect = useTelemetryStore((s) => s.connect);
  const disconnect = useTelemetryStore((s) => s.disconnect);
  const hydrate = useSessionStore((s) => s.hydrate);
  const hydrateSecurity = useSecurityStore((s) => s.hydrate);
  const hydrateAudit = useActivityStore((s) => s.hydrate);
  const hydrated = useSessionStore((s) => s.hydrated);

  useEntryFlow();

  useEffect(() => {
    void hydrate();
    void hydrateSecurity();
    void hydrateAudit();
  }, [hydrate, hydrateSecurity, hydrateAudit]);

  // Telemetry runs only while a pack is actually linked. It used to start on
  // mount regardless, which was harmless while frames went nowhere — now that
  // they are uploaded, streaming for a pack this phone is not connected to
  // would file readings against it.
  useEffect(() => {
    if (!connectedBatteryId) return;
    connect(connectedBatteryId);
    return disconnect;
  }, [connectedBatteryId, connect, disconnect]);

  // Hold on a plain themed ground rather than rendering a screen the guard is
  // about to replace.
  if (!hydrated) return <View style={{ flex: 1, backgroundColor: p.panelBase }} />;

  return (
    <View style={{ flex: 1, backgroundColor: p.panelBase }}>
      <StatusBar style={mode === 'dark' ? 'light' : 'dark'} />
      <ErrorBoundary scope="app">
        <Stack
          screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: p.panelBase },
          animation: 'slide_from_right',
        }}
      >
          <Stack.Screen name="write/[parameterKey]" options={{ presentation: 'modal' }} />
        </Stack>
      </ErrorBoundary>
    </View>
  );
}

export default function RootLayout() {
  const [loaded] = useFonts({
    SpaceGrotesk_500Medium,
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Fraunces_600SemiBold,
  });

  if (!loaded) return null;

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <Shell />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
