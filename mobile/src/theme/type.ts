/**
 * Type scale. Two families only:
 *   Space Grotesk — anything numeric or titular
 *   Inter         — prose and labels
 * Fraunces appears on exactly two screens (Login, Battery List) as the wordmark.
 *
 * Every numeral is tabular. A needle may twitch; a digit column may not reflow.
 */
import type { TextStyle } from 'react-native';

export const fonts = {
  grotesk: {
    medium: 'SpaceGrotesk_500Medium',
    semibold: 'SpaceGrotesk_600SemiBold',
    bold: 'SpaceGrotesk_700Bold',
  },
  inter: {
    regular: 'Inter_400Regular',
    medium: 'Inter_500Medium',
    semibold: 'Inter_600SemiBold',
    bold: 'Inter_700Bold',
  },
  fraunces: { semibold: 'Fraunces_600SemiBold' },
} as const;

const tabular: TextStyle = { fontVariant: ['tabular-nums'] };

export const type = {
  metricValue: {
    fontFamily: fonts.grotesk.bold,
    fontSize: 34,
    letterSpacing: -1,
    ...tabular,
  } as TextStyle,
  metricUnit: {
    fontFamily: fonts.grotesk.semibold,
    fontSize: 15,
  } as TextStyle,
  metricCaption: {
    fontFamily: fonts.inter.semibold,
    fontSize: 10,
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  } as TextStyle,
  screenTitle: {
    fontFamily: fonts.grotesk.bold,
    fontSize: 26,
    letterSpacing: -0.5,
    textTransform: 'uppercase',
  } as TextStyle,
  screenSub: {
    fontFamily: fonts.inter.medium,
    fontSize: 12,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  } as TextStyle,
  sectionLabel: {
    fontFamily: fonts.inter.bold,
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase',
  } as TextStyle,
  rowLabel: {
    fontFamily: fonts.inter.medium,
    fontSize: 14,
  } as TextStyle,
  rowValue: {
    fontFamily: fonts.grotesk.semibold,
    fontSize: 14,
    ...tabular,
  } as TextStyle,
  tabLabel: {
    fontFamily: fonts.inter.semibold,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  } as TextStyle,
  wordmark: {
    fontFamily: fonts.fraunces.semibold,
    fontSize: 30,
    letterSpacing: 0.2,
  } as TextStyle,
  body: {
    fontFamily: fonts.inter.regular,
    fontSize: 13,
    lineHeight: 20,
  } as TextStyle,
  caption: {
    fontFamily: fonts.inter.medium,
    fontSize: 11,
    lineHeight: 17,
  } as TextStyle,
} as const;

/** Hero readout scales with the gauge, so its sizes are functions of gauge size. */
export const heroType = (size: number) => ({
  value: {
    fontFamily: fonts.grotesk.bold,
    fontSize: size * 0.26,
    letterSpacing: -1.5,
    ...tabular,
  } as TextStyle,
  unit: {
    fontFamily: fonts.grotesk.semibold,
    fontSize: size * 0.115,
  } as TextStyle,
  caption: {
    fontFamily: fonts.inter.semibold,
    fontSize: size * 0.052,
    letterSpacing: 4.5,
    textTransform: 'uppercase',
  } as TextStyle,
});
