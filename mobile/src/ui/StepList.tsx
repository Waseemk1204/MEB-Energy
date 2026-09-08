import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Check } from 'lucide-react-native';
import { useTheme } from '../theme/ThemeProvider';
import { radii } from '../theme/tokens';
import { type as T } from '../theme/type';

export interface Step {
  label: string;
  done: boolean;
  active: boolean;
}

/**
 * Sequential progress, shared by the connect sequence and the safe-write flow.
 * Both are multi-stage operations against live hardware where the user should
 * be able to see which stage failed, not just that something failed.
 */
export function StepList({ steps, inset = true }: { steps: Step[]; inset?: boolean }) {
  const { p } = useTheme();
  return (
    <View style={[inset && styles.card, inset && { backgroundColor: p.panelAlt }]}>
      {steps.map((s) => (
        <View key={s.label} style={styles.row}>
          <View
            style={[
              styles.dot,
              {
                borderColor: s.done ? p.good : s.active ? p.accent : p.panelStitch,
                backgroundColor: s.done ? p.good : 'transparent',
              },
            ]}
          >
            {s.done ? (
              <Check size={10} color={p.panelBase} strokeWidth={3} />
            ) : s.active ? (
              <ActivityIndicator size="small" color={p.accent} />
            ) : null}
          </View>
          <Text style={[T.caption, { color: s.done || s.active ? p.inkStrong : p.inkFaint }]}>
            {s.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radii.card, padding: 16, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 20 },
  dot: {
    width: 18,
    height: 18,
    borderRadius: 99,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
