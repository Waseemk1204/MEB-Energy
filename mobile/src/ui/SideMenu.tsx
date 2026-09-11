import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  BackHandler,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../theme/ThemeProvider';
import { space } from '../theme/tokens';
import { type as T } from '../theme/type';

/**
 * The menu that slides in from the right.
 *
 * From the right on purpose: the button that opens it sits in the top-right of
 * the header, and a panel that arrives from the opposite side to the control
 * that summoned it reads as a different thing appearing rather than that
 * control expanding.
 *
 * Three things make it behave like a real modal rather than a floating panel:
 * the scrim closes it, the hardware back button closes it before leaving the
 * screen, and while it is open the content behind is hidden from screen
 * readers. Without the last one a reader walks straight past the menu into the
 * page underneath, which for a sighted user is covered by a dark scrim.
 */

export interface MenuItem {
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  onPress: () => void;
}

const DURATION = 220;

export function SideMenu({
  open,
  onClose,
  title,
  sub,
  items,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  sub?: string;
  items: MenuItem[];
}) {
  const { p } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  // Wide enough to read, never so wide it hides that there is a screen behind.
  const panelWidth = Math.min(320, width * 0.84);

  // Held in state rather than a ref: a ref's `.current` read during render is
  // exactly what the compiler cannot reason about, and this is read on every
  // render to build the transform. The initialiser runs once.
  const [slide] = useState(() => new Animated.Value(0));
  const reduceMotion = useRef(false);

  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (live) reduceMotion.current = enabled;
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    Animated.timing(slide, {
      toValue: open ? 1 : 0,
      // Somebody who has asked the system for less motion gets none: the panel
      // is simply there or not.
      duration: reduceMotion.current ? 0 : DURATION,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [open, slide]);

  /*
   * The hardware back button closes the menu instead of leaving the screen.
   * Without this, Android's back gesture would navigate away with a menu still
   * open over the screen it left.
   */
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [open, onClose]);

  if (!open) return null;

  return (
    <View style={StyleSheet.absoluteFill} accessibilityViewIsModal testID="side-menu">
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: slide }]}>
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(31,42,22,0.52)' }]}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close menu"
        />
      </Animated.View>

      <Animated.View
        style={[
          styles.panel,
          {
            width: panelWidth,
            backgroundColor: p.panelBase,
            paddingTop: insets.top + 14,
            paddingBottom: insets.bottom + 20,
            transform: [
              {
                translateX: slide.interpolate({
                  inputRange: [0, 1],
                  outputRange: [panelWidth, 0],
                }),
              },
            ],
          },
        ]}
      >
        <View style={styles.head}>
          <View style={{ flexShrink: 1 }}>
            <Text style={[T.screenTitle, { color: p.inkStrong, fontSize: 20 }]}>{title}</Text>
            {sub ? (
              <Text style={[T.caption, { color: p.inkSoft, marginTop: 3 }]}>{sub}</Text>
            ) : null}
          </View>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close menu"
            hitSlop={12}
            style={styles.close}
          >
            <X size={18} color={p.inkSoft} strokeWidth={2.4} />
          </Pressable>
        </View>

        <View style={styles.items}>
          {items.map((item) => (
            <Pressable
              key={item.label}
              onPress={() => {
                // Closed first: leaving a menu standing over the screen it
                // navigated to is how a panel starts to feel stuck.
                onClose();
                item.onPress();
              }}
              accessibilityRole="button"
              style={({ pressed }) => [
                styles.item,
                { backgroundColor: pressed ? p.panelAlt : 'transparent' },
              ]}
            >
              {item.icon}
              <View style={{ flexShrink: 1 }}>
                <Text style={[T.rowValue, { color: p.inkStrong }]}>{item.label}</Text>
                {item.hint ? (
                  <Text style={[T.caption, { color: p.inkFaint, marginTop: 1 }]}>{item.hint}</Text>
                ) : null}
              </View>
            </Pressable>
          ))}
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    paddingHorizontal: space.gutter,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 18,
  },
  // 44pt declared outright rather than relying on the icon plus hitSlop.
  close: { minWidth: 44, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' },
  items: { gap: 2 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 52,
    paddingHorizontal: 10,
    marginHorizontal: -10,
    borderRadius: 12,
  },
});
