import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Delete } from 'lucide-react-native';
import { useTheme } from '../theme/ThemeProvider';
import { type as T } from '../theme/type';
import { PIN_DIGITS } from '../store/pin';

/**
 * Numeric entry for the critical-write PIN. Its own pad rather than the system
 * keyboard: this is a deliberate-action gate, and a full keyboard sliding over
 * the value being changed defeats the point of showing that value.
 */
export function PinPad({
  value,
  onChange,
  onComplete,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  onComplete?: (pin: string) => void;
  disabled?: boolean;
}) {
  const { p } = useTheme();

  const pressDigit = (d: string) => {
    if (disabled || value.length >= PIN_DIGITS) return;
    const next = value + d;
    onChange(next);
    if (next.length === PIN_DIGITS) onComplete?.(next);
  };

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];

  return (
    <View>
      <View style={styles.dots} accessibilityLabel={`${value.length} of ${PIN_DIGITS} digits entered`}>
        {Array.from({ length: PIN_DIGITS }, (_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              {
                borderColor: p.inkFaint,
                backgroundColor: i < value.length ? p.inkStrong : 'transparent',
              },
            ]}
          />
        ))}
      </View>

      <View style={styles.pad}>
        {keys.map((k, i) => {
          if (k === '') return <View key={`sp${i}`} style={styles.key} />;
          const isDel = k === 'del';
          return (
            <Pressable
              key={k}
              disabled={disabled}
              onPress={() => (isDel ? onChange(value.slice(0, -1)) : pressDigit(k))}
              accessibilityRole="button"
              accessibilityLabel={isDel ? 'Delete' : k}
              style={({ pressed }) => [
                styles.key,
                {
                  backgroundColor: pressed ? p.panelAlt : 'transparent',
                  opacity: disabled ? 0.4 : 1,
                },
              ]}
            >
              {isDel ? (
                <Delete size={20} color={p.inkSoft} strokeWidth={2} />
              ) : (
                <Text style={[T.metricValue, { color: p.inkStrong, fontSize: 24 }]}>{k}</Text>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 12, paddingVertical: 18 },
  dot: { width: 12, height: 12, borderRadius: 99, borderWidth: 1.5 },
  pad: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
  key: {
    width: '33.33%',
    height: 58,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
  },
});
