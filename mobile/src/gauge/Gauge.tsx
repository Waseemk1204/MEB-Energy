/**
 * The instrument.
 *
 * SAFETY: there is deliberately no prop that can hide the numeric readout.
 * A needle position is an approximation by nature; a misread protection
 * threshold is a fire risk. `value` is required and always rendered as text.
 */
import React, { useEffect } from 'react';
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, G, Line, Path, Polygon, Text as SvgText } from 'react-native-svg';
import Animated, {
  useAnimatedProps,
  useSharedValue,
  useReducedMotion,
  withSpring,
} from 'react-native-reanimated';
import { angleFor, arcPath, needlePoints, polar, ticks } from './polar';
import { useTheme } from '../theme/ThemeProvider';
import { fonts, heroType, type as T } from '../theme/type';

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedPolygon = Animated.createAnimatedComponent(Polygon);

/** A real needle overshoots slightly and settles. A linear tween reads as a progress bar. */
export const NEEDLE_SPRING = { damping: 14, stiffness: 90, mass: 0.6 } as const;

export type GaugeVariant = 'hero' | 'metric' | 'strip';

export interface GaugeProps {
  variant: GaugeVariant;
  /** Required — this is the truth, and it is always drawn as text. */
  value: number;
  min: number;
  max: number;
  /** Spacing of labelled ticks. */
  major: number;
  /** Spacing of unlabelled ticks. Hero only. */
  minor?: number;
  label: string;
  unit: string;
  size?: number;
  /** Paint the value arc outward from zero rather than from the sweep start. */
  bipolar?: boolean;
  dangerZone?: [number, number];
  glyph?: React.ReactNode;
  /**
   * The reading is no longer live. The value still renders — losing it would be
   * worse — but the instrument must stop looking current.
   */
  stale?: boolean;
  format?: (v: number) => string;
  formatTick?: (v: number) => string;
  style?: StyleProp<ViewStyle>;
}

const SWEEP = {
  hero: { a0: -135, a1: 135 },
  metric: { a0: -115, a1: 115 },
  strip: { a0: -120, a1: 120 },
} as const;

export function Gauge({
  variant,
  value,
  min,
  max,
  major,
  minor,
  label,
  unit,
  size,
  bipolar = false,
  dangerZone,
  glyph,
  stale = false,
  format,
  formatTick,
  style,
}: GaugeProps) {
  const { p } = useTheme();
  const reduceMotion = useReducedMotion();
  const hero = variant === 'hero';
  const strip = variant === 'strip';

  const s = size ?? (hero ? 262 : strip ? 44 : 150);
  const { a0, a1 } = SWEEP[variant];

  const cx = s / 2;
  const cy = hero ? s / 2 : (s / 2) * 0.98;
  const r = s * 0.4;
  const stroke = s * (hero ? 0.055 : 0.05);
  const svgHeight = hero ? s : s * 0.8;

  const onLeather = hero;
  const trackColor = onLeather ? p.leatherTrack : p.panelTrack;
  const tickColor = onLeather ? p.leatherInkSoft : p.inkFaint;
  const needleColor = onLeather ? p.leatherNeedle : p.panelNeedle;
  const arcColor = onLeather ? p.leatherNeedle : p.accent;

  const sv = useSharedValue(value);
  useEffect(() => {
    sv.value = reduceMotion ? value : withSpring(value, NEEDLE_SPRING);
  }, [value, reduceMotion, sv]);

  const zeroAngle = bipolar ? angleFor(0, min, max, a0, a1) : a0;

  const arcProps = useAnimatedProps(() => ({
    d: arcPath(cx, cy, r, zeroAngle, angleFor(sv.value, min, max, a0, a1)),
  }));

  const needleProps = useAnimatedProps(() => ({
    points: needlePoints(
      cx,
      cy,
      angleFor(sv.value, min, max, a0, a1),
      r - s * 0.045,
      s * (hero ? 0.03 : 0.026),
      s * 0.006
    ),
  }));

  const readout = format ? format(value) : String(Math.round(value));

  // ---- strip: arc only, no needle. The parent row prints the number. ----
  if (strip) {
    return (
      <View style={[stale && styles.stale, style]}>
        <Svg width={s} height={s * 0.8} accessibilityRole="image" accessibilityLabel={label}>
          <Path
            d={arcPath(cx, cy, r, a0, a1)}
            stroke={trackColor}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
          />
          <AnimatedPath
            animatedProps={arcProps}
            stroke={arcColor}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
          />
        </Svg>
      </View>
    );
  }

  const majorTicks = ticks(min, max, major);
  const minorTicks = hero && minor ? ticks(min, max, minor) : [];

  return (
    <View style={[styles.column, stale && styles.stale, style]}>
      {/* METRIC: digits sit above the arc, never inside it. */}
      {!hero && (
        <View style={styles.metricReadout}>
          <Text style={[T.metricValue, { color: p.inkStrong }]}>{readout}</Text>
          <Text style={[T.metricUnit, { color: p.inkSoft, marginLeft: 4 }]}>{unit}</Text>
        </View>
      )}

      <View style={{ width: s, height: svgHeight }}>
        <Svg
          width={s}
          height={svgHeight}
          accessibilityRole="image"
          accessibilityLabel={
            stale
              ? `${label}: ${readout} ${unit}, not live`
              : `${label}: ${readout} ${unit}`
          }
        >
          {dangerZone && (
            <Path
              d={arcPath(
                cx,
                cy,
                r,
                angleFor(dangerZone[0], min, max, a0, a1),
                angleFor(dangerZone[1], min, max, a0, a1)
              )}
              stroke={p.critical}
              strokeWidth={stroke * 1.5}
              fill="none"
              opacity={0.42}
            />
          )}

          <Path
            d={arcPath(cx, cy, r, a0, a1)}
            stroke={trackColor}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
          />

          <AnimatedPath
            animatedProps={arcProps}
            stroke={arcColor}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            opacity={hero ? 0.55 : 0.62}
          />

          {minorTicks.map((v) => {
            if (Math.abs(v / major - Math.round(v / major)) < 1e-6) return null;
            const ang = angleFor(v, min, max, a0, a1);
            const i = polar(cx, cy, r + stroke * 0.55, ang);
            const o = polar(cx, cy, r + stroke * 0.55 + s * 0.022, ang);
            return (
              <Line
                key={`m${v}`}
                x1={i.x}
                y1={i.y}
                x2={o.x}
                y2={o.y}
                stroke={tickColor}
                strokeWidth={1}
                opacity={0.5}
              />
            );
          })}

          {majorTicks.map((v) => {
            const ang = angleFor(v, min, max, a0, a1);
            const i = polar(cx, cy, r + stroke * 0.55, ang);
            const o = polar(cx, cy, r + stroke * 0.55 + s * 0.05, ang);
            // Hero labels hug the ring so the centre stays clear for the readout;
            // metric dials have their digits above the arc, so theirs can sit deeper.
            const lp = polar(cx, cy, r - s * (hero ? 0.055 : 0.115), ang);
            return (
              <G key={`t${v}`}>
                <Line x1={i.x} y1={i.y} x2={o.x} y2={o.y} stroke={tickColor} strokeWidth={1.5} />
                <SvgText
                  x={lp.x}
                  y={lp.y}
                  fill={tickColor}
                  fontSize={s * 0.042}
                  fontFamily={fonts.inter.medium}
                  textAnchor="middle"
                  alignmentBaseline="middle"
                >
                  {formatTick ? formatTick(v) : String(Math.round(v))}
                </SvgText>
              </G>
            );
          })}

          <AnimatedPolygon animatedProps={needleProps} fill={needleColor} />
          {/* The hero needle emerges from behind its readout, as in the reference
              cluster — a drawn pivot there would punch through the digits. The
              metric dials are small enough to need a visible pivot. */}
          {!hero && (
            <>
              <Circle cx={cx} cy={cy} r={s * 0.034} fill={needleColor} />
              <Circle cx={cx} cy={cy} r={s * 0.013} fill={p.panelBase} />
            </>
          )}
        </Svg>

        {glyph && (
          <View
            pointerEvents="none"
            style={[styles.glyph, { left: 0, right: 0, top: cy - s * 0.19 }]}
          >
            {glyph}
          </View>
        )}

        {/* HERO: the number lives inside the ring and is the largest thing on screen. */}
        {hero && (
          <View pointerEvents="none" style={[styles.heroCentre, { top: cy - s * 0.25, width: s }]}>
            <View style={styles.heroLine}>
              <Text style={[heroType(s).value, { color: p.leatherInk }]}>{readout}</Text>
              <Text
                style={[
                  heroType(s).unit,
                  { color: p.leatherInkSoft, marginLeft: 3, marginBottom: s * 0.03 },
                ]}
              >
                {unit}
              </Text>
            </View>
            <Text style={[heroType(s).caption, { color: p.leatherInkSoft }]}>{label}</Text>
          </View>
        )}
      </View>

      {!hero && (
        <Text style={[T.metricCaption, { color: p.inkSoft, marginTop: -2 }]}>{label}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  column: { alignItems: 'center' },
  metricReadout: { flexDirection: 'row', alignItems: 'baseline', marginBottom: 2 },
  heroCentre: { position: 'absolute', alignItems: 'center' },
  heroLine: { flexDirection: 'row', alignItems: 'flex-end' },
  glyph: { position: 'absolute', alignItems: 'center' },
  /** Frozen readings read as inactive rather than current. */
  stale: { opacity: 0.38 },
});
