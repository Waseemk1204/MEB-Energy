import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MonitorSmartphone } from 'lucide-react-native';
import { useTheme } from '../theme/ThemeProvider';
import { radii } from '../theme/tokens';
import { type as T } from '../theme/type';
import { useSessionStore } from '../store/useSessionStore';

/**
 * Says that signing in here signed somebody out somewhere else.
 *
 * The company account is capped at a number of devices, and a sign-in past the
 * cap signs out the one used longest ago. The value of doing it that way
 * instead of refusing the newest device is precisely this banner: somebody who
 * did not sign in anywhere new has just learned that somebody else did.
 *
 * Dismissible, unlike StaleBanner — it reports something that has already
 * happened, not a condition that is still true.
 */
export function SignedOutBanner() {
  const { p } = useTheme();
  const signedOut = useSessionStore((s) => s.signedOut);
  const dismiss = useSessionStore((s) => s.dismissSignedOut);

  if (signedOut.length === 0) return null;

  const summary =
    signedOut.length === 1
      ? `Signing in here signed out ${signedOut[0]}.`
      : `Signing in here signed out ${signedOut.length} other devices.`;

  return (
    <View
      accessible
      accessibilityRole="alert"
      accessibilityLabel={`${summary} If that was not you, change this account's password.`}
      style={[styles.wrap, { backgroundColor: p.panelAlt, borderColor: p.warn }]}
    >
      <MonitorSmartphone size={16} color={p.warn} strokeWidth={2.2} />
      <View style={{ flex: 1 }}>
        <Text style={[T.rowValue, { color: p.warn, fontSize: 13 }]}>
          Another device was signed out
        </Text>
        <Text style={[T.caption, { color: p.inkSoft, marginTop: 3 }]}>
          {summary} This account is limited to a set number of devices. If that was not you,
          change its password.
        </Text>
        {signedOut.length > 1 ? (
          <Text style={[T.caption, { color: p.inkSoft, marginTop: 3 }]}>
            {signedOut.join('; ')}
          </Text>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        onPress={dismiss}
        hitSlop={12}
        style={styles.dismiss}
      >
        <Text style={[T.caption, { color: p.inkSoft }]}>Dismiss</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 11,
    borderWidth: 1,
    borderLeftWidth: 4,
    borderRadius: radii.card,
    paddingHorizontal: 14,
    paddingVertical: 13,
    marginHorizontal: 20,
    marginTop: 16,
    minHeight: 44,
  },
  dismiss: { minHeight: 44, justifyContent: 'center', paddingLeft: 4 },
});
