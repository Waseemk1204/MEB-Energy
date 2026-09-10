import { Platform, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * How far down the screen it is safe to start drawing.
 *
 * `useSafeAreaInsets().top` is the right answer and usually gives it. On
 * Android it can report 0 while the window is still drawing underneath the
 * status bar — the app is then laid out from the very top of the display and
 * its title sits behind the clock and the notification shade. Which of the two
 * happens depends on how the *host* window is configured, and under Expo Go
 * that is Expo Go's window rather than this app's, so it is not something this
 * codebase can settle by configuration alone.
 *
 * `StatusBar.currentHeight` is Android's own measurement of that bar and is
 * always populated there. Taking the larger of the two is correct either way:
 * when the inset is already right it wins and this is a no-op, and when it is
 * wrongly zero the measured bar height takes over. On iOS `currentHeight` is
 * undefined and the inset — which also covers the notch and Dynamic Island,
 * both taller than any status bar — is used unchanged.
 *
 * The floor is never applied blindly: a phone with no status bar and no notch
 * legitimately has a zero top inset, and Math.max leaves that alone.
 */
export function useTopInset(): number {
  const insets = useSafeAreaInsets();
  if (Platform.OS !== 'android') return insets.top;
  return Math.max(insets.top, StatusBar.currentHeight ?? 0);
}

/**
 * How far up from the bottom it is safe to stop drawing.
 *
 * The home indicator on iOS and the gesture bar on Android. No Android
 * equivalent of `StatusBar.currentHeight` exists for the bottom, so this is
 * the inset as reported — kept here so that screens take both edges from one
 * place and neither is forgotten.
 */
export function useBottomInset(): number {
  return useSafeAreaInsets().bottom;
}
