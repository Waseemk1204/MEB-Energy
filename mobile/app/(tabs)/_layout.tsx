import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Gauge as GaugeIcon, Grid3x3, Clock, Settings } from 'lucide-react-native';
import { useTheme } from '../../src/theme/ThemeProvider';
import { ErrorBoundary } from '../../src/ui/ErrorBoundary';
import { type as T } from '../../src/theme/type';

const ICONS = {
  index: GaugeIcon,
  cells: Grid3x3,
  history: Clock,
  settings: Settings,
} as const;

const LABELS = {
  index: 'Dash',
  cells: 'Cells',
  history: 'History',
  settings: 'Settings',
} as const;

/**
 * expo-router 57 vendors react-navigation's bottom tabs internally rather than
 * exposing @react-navigation/bottom-tabs as a dependency, so the tab bar props
 * are derived from the Tabs component itself instead of deep-importing a build
 * path that would break on the next SDK bump.
 */
type TabBarProps = Parameters<NonNullable<React.ComponentProps<typeof Tabs>['tabBar']>>[0];

/**
 * Four tabs, maximum. The active tab is a filled pill; inactive tabs are bare.
 *
 * The reference mock's DRIVE and CHARGING tabs are Tesla artefacts with no
 * gateway data behind them. Protection, BMS Info, Device, Support Session
 * and Help are reached from Dashboard rows instead — a fifth pill would make
 * the bar illegible at 375pt.
 */
function TabBar({ state, navigation }: TabBarProps) {
  const { p } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: p.panelBase,
          borderTopColor: p.panelStitch,
          paddingBottom: Math.max(insets.bottom, 14),
        },
      ]}
    >
      {state.routes.map((route, index) => {
        const key = route.name as keyof typeof ICONS;
        const Icon = ICONS[key];
        if (!Icon) return null;
        const focused = state.index === index;

        return (
          <Pressable
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={LABELS[key]}
            onPress={() => {
              const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
              if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
            }}
            style={styles.tab}
          >
            <View style={[styles.pill, focused && { backgroundColor: p.navPill }]}>
              <Icon size={17} color={focused ? p.navPillInk : p.navInactive} strokeWidth={2} />
            </View>
            <Text style={[T.tabLabel, { color: focused ? p.inkStrong : p.navInactive }]}>
              {LABELS[key]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{ headerShown: false }}
      tabBar={(props) => (
        // The bar is the way out of a broken screen, so it gets its own boundary.
        <ErrorBoundary scope="tab bar">
          <TabBar {...props} />
        </ErrorBoundary>
      )}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="cells" />
      <Tabs.Screen name="history" />
      <Tabs.Screen name="settings" />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingTop: 9,
    paddingHorizontal: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tab: { alignItems: 'center', gap: 5, minWidth: 64, minHeight: 48, paddingVertical: 4 },
  pill: { width: 44, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
});
