import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme } from '../src/theme/ThemeProvider';
import { radii } from '../src/theme/tokens';
import { type as T } from '../src/theme/type';
import { LeatherPanel } from '../src/ui/LeatherPanel';
import { PrimaryButton } from '../src/ui/primitives';
import { APP_NAME } from '../src/brand';
import { api } from '../src/api/session';
import { MIN_PASSWORD_LENGTH, acceptInvitation } from '../src/api/invitations';
import { useSessionStore } from '../src/store/useSessionStore';
import { useBottomInset, useTopInset } from '../src/ui/safeArea';

/**
 * Setting your own first password.
 *
 * Reached by a single-use link, with no account and no session. It is the one
 * screen a signed-out person is meant to see besides Login, so the entry
 * guard leaves it alone. If somebody else is signed in on this device, they
 * are signed out first: the link belongs to the new person.
 */
export default function AcceptInvite() {
  const { p } = useTheme();
  const router = useRouter();
  const topInset = useTopInset();
  const bottomInset = useBottomInset();
  const { token: raw } = useLocalSearchParams<{ token?: string | string[] }>();
  const token = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const longEnough = password.length >= MIN_PASSWORD_LENGTH;
  const matches = confirm.length > 0 && password === confirm;
  const ready = longEnough && matches && !busy && token !== '';

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const store = useSessionStore.getState();
      if (store.authenticated) store.signOut();
      const result = await acceptInvitation(api, token, password);
      await store.adopt(result);
      // Signed in: the entry guard would route from here anyway, but going
      // straight to Login lets it pick the right home without a flash of
      // this screen looking as though nothing happened.
      router.replace('/login');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not accept that invitation');
    } finally {
      setBusy(false);
    }
  };

  return (
    <LeatherPanel tone="hero" radius={0} style={{ flex: 1 }}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, paddingTop: topInset, paddingBottom: bottomInset + 24 }}
      >
        <View style={styles.brand}>
          <Text style={[T.wordmark, { color: p.leatherInk }]}>{APP_NAME}</Text>
          <Text style={[T.screenSub, { color: p.leatherInkSoft, marginTop: 8 }]}>
            {token ? 'Choose your password' : 'Invitation'}
          </Text>
        </View>

        <View style={styles.form}>
          {!token ? (
            <Text accessibilityRole="alert" style={[T.rowLabel, { color: p.leatherInk }]}>
              This link is missing its invitation code. Ask whoever invited you to send it again.
            </Text>
          ) : (
            <>
              <Field
                label={`Password (at least ${MIN_PASSWORD_LENGTH} characters)`}
                value={password}
                onChange={setPassword}
              />
              <Field label="Type it again" value={confirm} onChange={setConfirm} />

              {confirm.length > 0 && !matches ? (
                <Text style={[T.caption, { color: p.leatherInk, marginLeft: 3 }]}>
                  The two passwords do not match.
                </Text>
              ) : null}
              {error ? (
                <Text accessibilityRole="alert" style={[T.caption, { color: p.leatherInk, marginTop: 4, marginLeft: 3 }]}>
                  {error}
                </Text>
              ) : null}

              <View style={{ marginTop: 22 }}>
                <PrimaryButton
                  label={busy ? 'Setting up…' : 'Set password and sign in'}
                  disabled={!ready}
                  onPress={() => void submit()}
                />
              </View>
              <Text style={[T.caption, { color: p.leatherInkSoft, marginTop: 12, textAlign: 'center' }]}>
                The link works once. Nobody else sees the password you choose.
              </Text>
            </>
          )}
        </View>

        <View style={styles.foot}>
          <Pressable onPress={() => router.replace('/login')} accessibilityRole="link" style={{ minHeight: 44, justifyContent: 'center' }}>
            <Text style={[T.caption, { color: p.leatherInkSoft, textAlign: 'center' }]}>
              Already have an account? Sign in
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </LeatherPanel>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const { p } = useTheme();
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={[T.tabLabel, { color: p.leatherInkSoft, marginBottom: 7, marginLeft: 3 }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        secureTextEntry
        autoCapitalize="none"
        accessibilityLabel={label}
        style={[
          T.rowValue,
          styles.input,
          { color: p.inkStrong, backgroundColor: p.panelBase, borderColor: p.leatherStitch },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  brand: { flex: 1, justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 34 },
  form: { paddingHorizontal: 28 },
  input: {
    height: 52,
    borderRadius: radii.card,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    paddingHorizontal: 16,
    opacity: 0.92,
  },
  foot: { flex: 1, justifyContent: 'flex-end', paddingHorizontal: 28 },
});
