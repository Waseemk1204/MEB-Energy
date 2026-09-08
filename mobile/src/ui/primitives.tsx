/**
 * Shared primitives. Composing repeated things as one object is what keeps
 * thirteen screens reading as one product.
 */
import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { useTheme } from '../theme/ThemeProvider';
import { dangerColor, space, type DangerLevel } from '../theme/tokens';
import { type as T } from '../theme/type';
import { LeatherPanel } from './LeatherPanel';

/* ------------------------------------------------------------------ dots */

/**
 * Severity is carried by colour, and `good` and `warn` sit at almost identical
 * luminance in the light theme — so colour alone is not a channel a colour-blind
 * user can read. The label is what makes the level available to everyone.
 */
export function DangerDot({ level }: { level: DangerLevel }) {
  const { p } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${level} severity`}
      style={[styles.dot, { backgroundColor: dangerColor(p, level) }]}
    />
  );
}

/* ----------------------------------------------------------------- chips */

export type ChipTone = 'good' | 'warn' | 'critical' | 'neutral';

export function StatusChip({ tone, label }: { tone: ChipTone; label: string }) {
  const { p } = useTheme();
  const color =
    tone === 'good' ? p.good : tone === 'warn' ? p.warn : tone === 'critical' ? p.critical : p.inkFaint;
  return (
    <View style={[styles.chip, { borderColor: color }]}>
      <View style={[styles.dot, { backgroundColor: color, marginRight: 6 }]} />
      <Text style={[T.tabLabel, { color }]}>{label}</Text>
    </View>
  );
}

/** Read-only marker used where the datasheet, not the user, decides a value. */
export function FixedTag({ label = 'SKU-fixed' }: { label?: string }) {
  const { p } = useTheme();
  return (
    <View style={[styles.tag, { borderColor: p.panelStitch }]}>
      <Text style={[T.tabLabel, { color: p.inkFaint, fontSize: 8.5 }]}>{label}</Text>
    </View>
  );
}

/* ----------------------------------------------------------------- label */

export function SectionLabel({ children }: { children: React.ReactNode }) {
  const { p } = useTheme();
  return <Text style={[T.sectionLabel, { color: p.inkFaint }, styles.sectionLabel]}>{children}</Text>;
}

/* ------------------------------------------------------------------ rows */

export function DataRow({
  label,
  value,
  level,
  trailing,
  onPress,
  dimmed,
  first,
}: {
  label: string;
  value?: string;
  level?: DangerLevel;
  trailing?: React.ReactNode;
  onPress?: () => void;
  dimmed?: boolean;
  first?: boolean;
}) {
  const { p } = useTheme();
  const body = (
    <View
      style={[
        styles.row,
        !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.panelStitch },
        dimmed && { opacity: 0.62 },
      ]}
    >
      <View style={styles.rowLeft}>
        {level && <DangerDot level={level} />}
        <Text style={[T.rowLabel, { color: p.inkStrong, flexShrink: 1 }]}>{label}</Text>
      </View>
      <View style={styles.rowRight}>
        {value !== undefined && <Text style={[T.rowValue, { color: p.inkSoft }]}>{value}</Text>}
        {trailing}
        {onPress && <ChevronRight size={15} color={p.inkFaint} />}
      </View>
    </View>
  );

  if (!onPress) return body;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        [label, value, level && `${level} severity`].filter(Boolean).join(', ')
      }
      style={({ pressed }) => (pressed ? { opacity: 0.6 } : undefined)}
    >
      {body}
    </Pressable>
  );
}

/** Groups DataRows into one stitched card. */
export function RowGroup({
  tone = 'panel',
  style,
  children,
}: {
  tone?: 'panel' | 'alt';
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const items = React.Children.toArray(children).filter(Boolean);
  return (
    <LeatherPanel tone={tone} style={style}>
      {items.map((child, i) =>
        React.isValidElement<{ first?: boolean }>(child)
          ? React.cloneElement(child, { first: i === 0 })
          : child
      )}
    </LeatherPanel>
  );
}

/* ------------------------------------------------------------ fact strip */

export interface Fact {
  label: string;
  value: string;
  sub?: string;
  tone?: ChipTone;
}

/** Every screen closes with one of these, never a naked scroll end. */
export function FactStrip({ facts }: { facts: Fact[] }) {
  const { p } = useTheme();
  return (
    <View style={styles.facts}>
      {facts.map((f) => (
        <View key={f.label} style={styles.fact}>
          <Text style={[T.metricCaption, { color: p.inkFaint, fontSize: 9.5, letterSpacing: 1.3 }]}>
            {f.label}
          </Text>
          <Text style={[T.rowValue, { color: p.inkStrong, fontSize: 15, marginTop: 6 }]}>
            {f.value}
          </Text>
          {f.sub && (
            <Text
              style={[
                T.caption,
                {
                  marginTop: 3,
                  color:
                    f.tone === 'good'
                      ? p.good
                      : f.tone === 'warn'
                        ? p.warn
                        : f.tone === 'critical'
                          ? p.critical
                          : p.inkSoft,
                },
              ]}
            >
              {f.sub}
            </Text>
          )}
        </View>
      ))}
    </View>
  );
}

/* ----------------------------------------------------------------- title */

export function ScreenTitle({ title, sub }: { title: string; sub: string }) {
  const { p } = useTheme();
  return (
    <View style={styles.screenTitle}>
      <Text style={[T.screenTitle, { color: p.leatherInk }]}>{title}</Text>
      <Text style={[T.screenSub, { color: p.leatherInkSoft, marginTop: 7 }]}>{sub}</Text>
    </View>
  );
}

/* --------------------------------------------------------------- buttons */

export function PrimaryButton({
  label,
  onPress,
  disabled,
  tone = 'default',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'default' | 'critical';
}) {
  const { p } = useTheme();
  const bg = tone === 'critical' ? p.critical : p.navPill;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: disabled ? 0.38 : pressed ? 0.85 : 1 },
      ]}
    >
      <Text style={[T.tabLabel, { color: p.navPillInk, fontSize: 12 }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  dot: { width: 7, height: 7, borderRadius: 99 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  tag: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 6, paddingVertical: 3 },
  sectionLabel: { marginTop: 20, marginBottom: 9, marginLeft: 3 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 15,
    paddingVertical: 13,
    minHeight: 48,
  },
  rowLeft: { flexDirection: 'row', alignItems: 'center', gap: 9, flexShrink: 1 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  facts: { flexDirection: 'row', paddingHorizontal: space.panel, paddingVertical: 16, gap: 8 },
  fact: { flex: 1, alignItems: 'center' },
  screenTitle: { paddingHorizontal: 22, paddingTop: 16, paddingBottom: 18 },
  button: {
    height: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
