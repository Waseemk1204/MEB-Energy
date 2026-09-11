import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useTheme } from '../theme/ThemeProvider';
import { space } from '../theme/tokens';
import { type as T } from '../theme/type';
import { LeatherPanel } from './LeatherPanel';
import { useBottomInset, useTopInset } from './safeArea';

/**
 * Every screen that isn't the Dashboard: a thin pinned leather header over a
 * scrolling cream body. Leather never scrolls; cream always does.
 */
export function ScreenScaffold({
  title,
  sub,
  back = true,
  right,
  children,
  scroll = true,
  overlay,
}: {
  title: string;
  sub: string;
  back?: boolean;
  right?: React.ReactNode;
  children: React.ReactNode;
  scroll?: boolean;
  /**
   * Drawn over the whole screen, above the header and the scrolling body.
   *
   * For a menu or a sheet: putting one inside `children` would leave it
   * trapped under the pinned header and clipped by the scroller, which is
   * where a panel starts sliding in behind the thing that opened it.
   */
  overlay?: React.ReactNode;
}) {
  const { p } = useTheme();
  const router = useRouter();
  const topInset = useTopInset();
  const bottomInset = useBottomInset();

  const Body = scroll ? ScrollView : View;

  return (
    <View style={{ flex: 1, backgroundColor: p.panelBase }}>
      <LeatherPanel tone="hero" radius={0} style={{ paddingTop: topInset + 8, paddingBottom: 8 }}>
        <View style={styles.head}>
          <View style={{ flexShrink: 1 }}>
            {back && (
              <Pressable
                onPress={() => router.back()}
                accessibilityRole="button"
                accessibilityLabel="Back"
                hitSlop={12}
                style={styles.back}
              >
                <ChevronLeft size={16} color={p.leatherInkSoft} strokeWidth={2.4} />
                <Text style={[T.tabLabel, { color: p.leatherInkSoft }]}>Back</Text>
              </Pressable>
            )}
            <Text style={[T.screenTitle, { color: p.leatherInk }]}>{title}</Text>
            <Text style={[T.screenSub, { color: p.leatherInkSoft, marginTop: 7 }]}>{sub}</Text>
          </View>
          {right}
        </View>
      </LeatherPanel>

      <Body
        style={{ flex: 1 }}
        contentContainerStyle={
          scroll ? { paddingHorizontal: space.gutter, paddingBottom: bottomInset + 32 } : undefined
        }
        showsVerticalScrollIndicator={false}
      >
        {children}
      </Body>

      {overlay}
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingHorizontal: 22,
    paddingTop: 12,
    paddingBottom: 16,
    gap: 12,
  },
  // 44pt minimum declared outright rather than relying on content plus hitSlop.
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    minHeight: 44,
    marginBottom: 4,
    marginLeft: -4,
  },
});
