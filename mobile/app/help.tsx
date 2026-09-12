import React, { useState } from 'react';
import { LayoutAnimation, Platform, Pressable, Share, StyleSheet, Text, UIManager, View } from 'react-native';
import { ChevronDown } from 'lucide-react-native';
import { useTheme } from '../src/theme/ThemeProvider';
import { APP_NAME } from '../src/brand';
import { radii } from '../src/theme/tokens';
import { type as T } from '../src/theme/type';
import { ScreenScaffold } from '../src/ui/ScreenScaffold';
import { PrimaryButton, SectionLabel } from '../src/ui/primitives';
import { clearLog, formatLog, getLog } from '../src/diagnostics/fieldLog';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/** Safety first, then troubleshooting, then bookkeeping. */
const TOPICS = [
  {
    q: 'What can changing a critical parameter do?',
    a: 'Protection thresholds are what stop a pack from being charged, discharged or heated past its safe limits. Raising cell over-voltage, lowering under-voltage, or widening a temperature limit removes the margin the BMS uses to cut current before damage occurs. In the worst case that means cell damage, venting, or thermal runaway. Change these only against a written instruction from the pack manufacturer, and record that instruction in the reason field.',
  },
  {
    q: 'Why does a critical change need a reason?',
    a: 'Because the audit record is the primary safety-relevant account of what happened to this battery. Six months later, "who set over-voltage to 3.8 V and why" is a question the reason field answers and a timestamp alone does not.',
  },
  {
    q: 'The app cannot find my gateway',
    a: 'Check that Bluetooth is on, that you are within a few metres of the vehicle, and that the gateway LED is lit. The app will not connect to a peripheral that fails device authentication — if a device appears and then disappears, it is being rejected as unverified rather than failing to pair.',
  },
  {
    q: 'A value changed and I did not change it',
    a: 'An administrator can write to this battery remotely while your Bluetooth session is active. They do not need your approval, so you are not prompted — but every such change appears on the dashboard as a banner and in Activity tagged "Admin remote" or "Admin Force Push", with the administrator named.',
  },
  {
    q: 'Can an administrator reach my battery when I am not connected?',
    a: 'No. Commands only reach the BMS through your active Bluetooth session. With the app closed or out of range, an administrator\'s command is queued or rejected at the cloud and never delivered. This is architectural, not a setting.',
  },
  {
    q: 'What does the audit log record?',
    a: 'Timestamp, who acted and under which company, the exact battery, BMS and gateway, the parameter, its old and new values, the reason, the source (local, admin remote, or force push), app and firmware versions, the result, and the BMS response. Rejected attempts are recorded as well as successful ones.',
  },
];

export default function Help() {
  const { p } = useTheme();
  const [open, setOpen] = useState<number | null>(0);

  return (
    <ScreenScaffold title="Help" sub="Safety & troubleshooting">
      <SectionLabel>Common questions</SectionLabel>
      {TOPICS.map((t, i) => {
        const isOpen = open === i;
        return (
          <Pressable
            key={t.q}
            onPress={() => {
              LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
              setOpen(isOpen ? null : i);
            }}
            accessibilityRole="button"
            accessibilityState={{ expanded: isOpen }}
            style={[styles.item, { backgroundColor: p.panelAlt }]}
          >
            <View style={styles.head}>
              <Text style={[T.rowLabel, { color: p.inkStrong, flex: 1 }]}>{t.q}</Text>
              <ChevronDown
                size={16}
                color={p.inkFaint}
                strokeWidth={2.2}
                style={{ transform: [{ rotate: isOpen ? '180deg' : '0deg' }] }}
              />
            </View>
            {isOpen && <Text style={[T.body, { color: p.inkSoft, marginTop: 10 }]}>{t.a}</Text>}
          </Pressable>
        );
      })}

      <SectionLabel>Diagnostics</SectionLabel>
      <View style={[styles.item, { backgroundColor: p.panelAlt }]}>
        <Text style={[T.rowLabel, { color: p.inkStrong }]}>Diagnostic log</Text>
        <Text style={[T.caption, { color: p.inkSoft, marginTop: 6 }]}>
          {getLog().length} recent connection and write events, held on this device only. Export it
          alongside a description of what you were doing — it is what turns a report into something
          fixable. It contains no PINs, tokens or passwords.
        </Text>
        <View style={{ marginTop: 14 }}>
          <PrimaryButton
            label="Export diagnostic log"
            onPress={() =>
              Share.share({ title: `${APP_NAME} diagnostic log`, message: formatLog() })
            }
          />
        </View>
        <Pressable
          onPress={clearLog}
          accessibilityRole="button"
          accessibilityLabel="Clear diagnostic log"
          style={styles.clear}
        >
          <Text style={[T.caption, { color: p.inkFaint, textAlign: 'center' }]}>Clear log</Text>
        </Pressable>
      </View>

      <SectionLabel>Support</SectionLabel>
      <View style={[styles.item, { backgroundColor: p.panelAlt }]}>
        <Text style={[T.rowLabel, { color: p.inkStrong }]}>Support</Text>
        <Text style={[T.caption, { color: p.inkSoft, marginTop: 6 }]}>
          Ask your administrator · Quote your battery ID and, if one is running, the support
          session ID from the Support screen.
        </Text>
      </View>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  item: { borderRadius: radii.card, padding: 16, marginBottom: 10 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  clear: { minHeight: 44, justifyContent: 'center', marginTop: 4 },
});
