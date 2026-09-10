import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '../src/theme/ThemeProvider';
import { radii } from '../src/theme/tokens';
import { type as T } from '../src/theme/type';
import { LeatherPanel } from '../src/ui/LeatherPanel';
import { PrimaryButton } from '../src/ui/primitives';
import { profile } from '../src/bms/capabilityProfile';
import { useSessionStore } from '../src/store/useSessionStore';
import { useBottomInset, useTopInset } from '../src/ui/safeArea';

/** Full-bleed leather, no cream panel. The only other Fraunces screen is the battery list. */
export default function Login() {
  const { p } = useTheme();
  const topInset = useTopInset();
  const bottomInset = useBottomInset();
  const signIn = useSessionStore((s) => s.signIn);
  const signingIn = useSessionStore((s) => s.signingIn);
  const error = useSessionStore((s) => s.error);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const ready = email.trim().length > 3 && password.length > 0 && !signingIn;

  return (
    <LeatherPanel tone="hero" radius={0} style={{ flex: 1 }}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1, paddingTop: topInset, paddingBottom: bottomInset + 24 }}
      >
        <View style={styles.brand}>
          <Text style={[T.wordmark, { color: p.leatherInk }]}>KnowyourEV</Text>
          <Text style={[T.screenSub, { color: p.leatherInkSoft, marginTop: 8 }]}>
            Battery diagnostics & configuration
          </Text>
        </View>

        <View style={styles.form}>
          <Field
            label="Email"
            value={email}
            onChange={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
          />
          <Field label="Password" value={password} onChange={setPassword} secure />

          {/*
            The reason a sign-in failed is shown verbatim from the store, which
            says the same thing for a wrong email as for a wrong password.
          */}
          {error ? (
            <Text
              accessibilityRole="alert"
              style={[T.caption, { color: p.leatherInk, marginTop: 4, marginLeft: 3 }]}
            >
              {error}
            </Text>
          ) : null}

          <View style={{ marginTop: 22 }}>
            {/* The entry-flow guard routes onward once the session is set. */}
            <PrimaryButton
              label={signingIn ? 'Signing in…' : 'Sign in'}
              disabled={!ready}
              onPress={() => void signIn(email, password)}
            />
          </View>
        </View>

        <View style={styles.foot}>
          <Text style={[T.caption, { color: p.leatherInkSoft, textAlign: 'center' }]}>
            v1.0.0 · Supported BMS: {profile.vendor} {profile.bmsModel}
          </Text>
        </View>
      </KeyboardAvoidingView>
    </LeatherPanel>
  );
}

function Field({
  label,
  value,
  onChange,
  secure,
  keyboardType,
  autoCapitalize,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  secure?: boolean;
  keyboardType?: 'email-address';
  autoCapitalize?: 'none';
}) {
  const { p } = useTheme();
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={[T.tabLabel, { color: p.leatherInkSoft, marginBottom: 7, marginLeft: 3 }]}>
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        secureTextEntry={secure}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        accessibilityLabel={label}
        style={[
          T.rowValue,
          styles.input,
          { color: p.leatherInk, backgroundColor: p.panelBase, borderColor: p.leatherStitch },
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
