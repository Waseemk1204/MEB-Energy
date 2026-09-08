import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../theme/ThemeProvider';
import { type as T } from '../theme/type';
import { useActivityStore } from '../store/useActivityStore';

/**
 * Passive reflection of an admin-initiated change (PRD §6.3 step 8).
 *
 * It appears, it never blocks, and it requires no dismissal tap — an admin
 * remote write deliberately shows the user no approval prompt, so this banner
 * plus the Activity timeline are the only way someone standing next to a live
 * pack learns its protection parameters just changed. Critical-level changes
 * get the stronger rail colour the PRD's open questions ask for.
 */
export function PassiveChangeBanner() {
  const { p } = useTheme();
  const router = useRouter();
  const entries = useActivityStore((s) => s.entries);
  const unseenId = useActivityStore((s) => s.unseenAdminEntryId);

  const entry = entries.find((e) => e.id === unseenId);
  if (!entry) return null;

  const critical = entry.dangerLevel === 'Critical';
  const rail = critical ? p.critical : p.accent;

  return (
    <Pressable
      onPress={() => router.push('/activity')}
      accessibilityRole="button"
      accessibilityLabel={`${entry.displayName} changed remotely to ${entry.newValue}. Open activity.`}
      style={({ pressed }) => [
        styles.wrap,
        { backgroundColor: p.panelAlt, borderLeftColor: rail, opacity: pressed ? 0.8 : 1 },
      ]}
    >
      <View style={[styles.dot, { backgroundColor: rail }]} />
      <View style={{ flex: 1 }}>
        <Text style={[T.caption, { color: p.inkSoft }]}>
          <Text style={{ color: p.inkStrong, fontWeight: '600' }}>
            {entry.displayName} changed to {entry.newValue}.
          </Text>{' '}
          Set remotely by {entry.actor}
          {entry.supportSessionId ? ` during support session ${entry.supportSessionId}` : ''} —
          nothing for you to approve.
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 11,
    borderLeftWidth: 3,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginHorizontal: 20,
    marginTop: 16,
    // Tall in practice; declared so the 44pt guarantee is verifiable.
    minHeight: 44,
  },
  dot: { width: 7, height: 7, borderRadius: 99, marginTop: 5 },
});
