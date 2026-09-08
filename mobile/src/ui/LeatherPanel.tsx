import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../theme/ThemeProvider';
import { radii } from '../theme/tokens';
import { StitchBorder } from './StitchBorder';

export type PanelTone = 'hero' | 'panel' | 'alt';

/**
 * The base of every surface in the app.
 *
 *   hero  → leather gradient. Live instrumentation. Always pinned, never scrolls.
 *   panel → cream matte. Data and controls. Always scrolls.
 *   alt   → cream, one step down, for grouped rows inside a panel.
 */
export function LeatherPanel({
  tone = 'panel',
  radius,
  style,
  children,
}: {
  tone?: PanelTone;
  radius?: number;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}) {
  const { p } = useTheme();
  const r = radius ?? (tone === 'hero' ? radii.hero : radii.card);
  const stitchColor = tone === 'hero' ? p.leatherStitch : p.panelStitch;

  if (tone === 'hero') {
    return (
      <View style={[{ borderRadius: r, overflow: 'hidden' }, style]}>
        <LinearGradient
          colors={p.leatherGradient as unknown as readonly [string, string, ...string[]]}
          locations={[0, 0.52, 1]}
          start={{ x: 0.15, y: 0 }}
          end={{ x: 0.85, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <StitchBorder color={stitchColor} radius={r} />
        {children}
      </View>
    );
  }

  return (
    <View
      style={[
        { backgroundColor: tone === 'alt' ? p.panelAlt : p.panelBase, borderRadius: r },
        style,
      ]}
    >
      <StitchBorder color={stitchColor} radius={r} />
      {children}
    </View>
  );
}
