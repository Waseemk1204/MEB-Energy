import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { WifiOff } from 'lucide-react-native';
import { useTheme } from '../theme/ThemeProvider';
import { radii } from '../theme/tokens';
import { type as T } from '../theme/type';
import type { Freshness } from '../telemetry/freshness';

/**
 * Says, unambiguously, that the numbers above are not live.
 *
 * Deliberately not dismissible and deliberately loud: an instrument that has
 * stopped updating without saying so is more dangerous than no instrument, so
 * this stays until real data returns.
 */
export function StaleBanner({ freshness }: { freshness: Freshness }) {
  const { p } = useTheme();
  if (!freshness.stale) return null;

  const never = !Number.isFinite(freshness.ageMs);

  return (
    <View
      accessible
      accessibilityRole="alert"
      accessibilityLabel={
        never
          ? 'No telemetry received. The readings shown are not live.'
          : `Live data lost. The readings shown are ${freshness.ageLabel} old.`
      }
      style={[styles.wrap, { backgroundColor: p.panelAlt, borderColor: p.critical }]}
    >
      <WifiOff size={16} color={p.critical} strokeWidth={2.2} />
      <View style={{ flex: 1 }}>
        <Text style={[T.rowValue, { color: p.critical, fontSize: 13 }]}>
          {never ? 'No live data' : `No live data — last reading ${freshness.ageLabel} ago`}
        </Text>
        <Text style={[T.caption, { color: p.inkSoft, marginTop: 3 }]}>
          The readings below are frozen at their last value. Reconnect before acting on them.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 11,
    borderWidth: 1,
    borderLeftWidth: 4,
    borderRadius: radii.card,
    paddingHorizontal: 14,
    paddingVertical: 13,
    marginHorizontal: 20,
    marginTop: 16,
    minHeight: 44,
  },
});
