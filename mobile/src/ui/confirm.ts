import { Alert, Platform } from 'react-native';

/**
 * A destructive-action confirmation that works on every platform.
 *
 * `Alert.alert` renders nothing on the web — react-native-web implements it
 * as a no-op — so a destructive action guarded only by it would never run in
 * the browser, and would run *unasked* if anyone ever "fixed" that by calling
 * the action directly. The web gets the browser's own confirm dialog instead,
 * which is plain but is at least a real question.
 */
export function confirmDestructive(
  title: string,
  message: string,
  action: string,
  onConfirm: () => void
): void {
  if (Platform.OS === 'web') {
    const ask = (globalThis as { confirm?: (m: string) => boolean }).confirm;
    if (typeof ask !== 'function' || ask(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: action, style: 'destructive', onPress: onConfirm },
  ]);
}
