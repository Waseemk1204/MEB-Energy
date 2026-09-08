import React from 'react';
import { StyleSheet, View, type ColorValue } from 'react-native';
import { stitch } from '../theme/tokens';

/**
 * The stitch is the only border in this app.
 *
 * A dashed line inset 9pt from the panel edge. No card hairlines, no Material
 * elevation — depth comes from the material change (leather vs cream) instead.
 */
export function StitchBorder({
  color,
  radius,
  inset = stitch.inset,
}: {
  color: ColorValue;
  /** Outer radius of the panel; the stitch radius is derived from it. */
  radius: number;
  inset?: number;
}) {
  return (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {
          margin: inset,
          borderWidth: stitch.width,
          borderStyle: 'dashed',
          borderColor: color as string,
          borderRadius: Math.max(radius - inset, 4),
          opacity: stitch.opacity,
        },
      ]}
    />
  );
}
