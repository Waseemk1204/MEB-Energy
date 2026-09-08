import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ShieldCheck } from 'lucide-react-native';
import { useTheme } from '../src/theme/ThemeProvider';
import { radii } from '../src/theme/tokens';
import { type as T } from '../src/theme/type';
import { ScreenScaffold } from '../src/ui/ScreenScaffold';
import { PinPad } from '../src/ui/PinPad';
import { PrimaryButton } from '../src/ui/primitives';
import { PIN_DIGITS, isValidPinFormat } from '../src/store/pin';
import { useSecurityStore } from '../src/store/useSecurityStore';

type Phase = 'enter' | 'confirm' | 'done';

/** Set or replace the PIN that guards critical writes. */
export default function PinSetup() {
  const { p } = useTheme();
  const router = useRouter();
  const pinSet = useSecurityStore((s) => s.pinSet);
  const setPin = useSecurityStore((s) => s.setPin);
  const removePin = useSecurityStore((s) => s.removePin);

  const [phase, setPhase] = useState<Phase>('enter');
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [error, setError] = useState<string | null>(null);

  const value = phase === 'confirm' ? second : first;
  const onChange = (v: string) => {
    setError(null);
    if (phase === 'confirm') setSecond(v);
    else setFirst(v);
  };

  const onComplete = async (pin: string) => {
    if (phase === 'enter') {
      if (!isValidPinFormat(pin)) {
        setError(`Enter ${PIN_DIGITS} digits.`);
        setFirst('');
        return;
      }
      // Reject the two patterns that make a PIN worthless.
      if (/^(\d)\1+$/.test(pin)) {
        setError('Pick a PIN that is not all the same digit.');
        setFirst('');
        return;
      }
      if ('0123456789'.includes(pin) || '9876543210'.includes(pin)) {
        setError('Pick a PIN that is not a run of consecutive digits.');
        setFirst('');
        return;
      }
      setPhase('confirm');
      return;
    }

    if (pin !== first) {
      setError('Those did not match. Start again.');
      setPhase('enter');
      setFirst('');
      setSecond('');
      return;
    }

    await setPin(pin);
    setPhase('done');
    setTimeout(() => router.back(), 800);
  };

  return (
    <ScreenScaffold
      title={pinSet ? 'Change PIN' : 'Set PIN'}
      sub="Required for critical writes"
    >
      <View style={[styles.note, { backgroundColor: p.panelAlt, borderLeftColor: p.accent }]}>
        <ShieldCheck size={16} color={p.accent} strokeWidth={2.2} />
        <Text style={[T.caption, { color: p.inkSoft, flex: 1 }]}>
          This PIN is asked for before any change to a parameter marked Critical. It guards against
          a mistap or someone else picking up your unlocked phone — it is not a substitute for
          signing in, and the platform enforces permissions on the server regardless.
        </Text>
      </View>

      {phase === 'done' ? (
        <View style={styles.done}>
          <Text style={[T.metricValue, { color: p.good, fontSize: 22 }]}>PIN set</Text>
        </View>
      ) : (
        <>
          <Text style={[T.sectionLabel, { color: p.inkFaint, marginTop: 22, textAlign: 'center' }]}>
            {phase === 'confirm' ? 'Re-enter to confirm' : `Choose a ${PIN_DIGITS}-digit PIN`}
          </Text>

          <PinPad value={value} onChange={onChange} onComplete={onComplete} />

          <Text
            style={[
              T.caption,
              { color: error ? p.critical : p.inkFaint, textAlign: 'center', minHeight: 34 },
            ]}
          >
            {error ?? ' '}
          </Text>
        </>
      )}

      {pinSet && phase !== 'done' && (
        <View style={{ marginTop: 10 }}>
          <PrimaryButton
            label="Remove PIN"
            tone="critical"
            onPress={async () => {
              await removePin();
              router.back();
            }}
          />
          <Text style={[T.caption, { color: p.inkFaint, marginTop: 10, textAlign: 'center' }]}>
            Removing the PIN means critical writes need only the acknowledgement and reason.
          </Text>
        </View>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  note: {
    flexDirection: 'row',
    gap: 11,
    alignItems: 'flex-start',
    borderLeftWidth: 3,
    borderRadius: radii.card,
    padding: 14,
    marginTop: 18,
  },
  done: { alignItems: 'center', paddingVertical: 60 },
});
