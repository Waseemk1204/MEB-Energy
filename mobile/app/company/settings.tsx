import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useTheme } from '../../src/theme/ThemeProvider';
import { radii, space } from '../../src/theme/tokens';
import { type as T } from '../../src/theme/type';
import { ScreenScaffold } from '../../src/ui/ScreenScaffold';
import { DataRow, PrimaryButton, RowGroup, SectionLabel } from '../../src/ui/primitives';
import { api } from '../../src/api/session';
import { renameCompany } from '../../src/api/company';
import { useSessionStore } from '../../src/store/useSessionStore';
import { useSecurityStore } from '../../src/store/useSecurityStore';
import { useInstallPrompt } from '../../src/pwa/install';
import { APP_NAME } from '../../src/brand';

/**
 * The company's own settings: its name, this account, and the app itself.
 *
 * Pack parameters live on the Settings tab of a connected pack, where they
 * belong to the pack. This is everything that is not about a pack.
 */
export default function CompanySettings() {
  const { p } = useTheme();
  const router = useRouter();
  const company = useSessionStore((s) => s.company);
  const operator = useSessionStore((s) => s.operator);
  const signOut = useSessionStore((s) => s.signOut);
  const pinSet = useSecurityStore((s) => s.pinSet);
  const install = useInstallPrompt();

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(company);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onRename = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === company) return;
    setBusy(true);
    setError(null);
    try {
      const next = await renameCompany(api, trimmed);
      useSessionStore.setState({ company: next.name });
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not rename the company');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenScaffold title="Company settings" sub={company || APP_NAME}>
      {error ? (
        <View style={[styles.notice, { backgroundColor: p.panelAlt }]}>
          <Text style={[T.rowLabel, { color: p.critical }]}>{error}</Text>
        </View>
      ) : null}

      <SectionLabel>Company</SectionLabel>
      {editing ? (
        <View style={[styles.form, { backgroundColor: p.panelAlt }]}>
          <Text style={[T.sectionLabel, { color: p.inkFaint }]}>Name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            accessibilityLabel="Company name"
            autoCapitalize="words"
            style={[styles.input, { backgroundColor: p.panelBase, color: p.inkStrong, borderColor: p.panelStitch }]}
          />
          <PrimaryButton
            label={busy ? 'Saving…' : 'Save name'}
            onPress={() => void onRename()}
            disabled={busy || !name.trim() || name.trim() === company}
          />
          <Pressable
            onPress={() => {
              setEditing(false);
              setName(company);
            }}
            accessibilityRole="button"
            style={styles.cancel}
          >
            <Text style={[T.tabLabel, { color: p.inkSoft }]}>Cancel</Text>
          </Pressable>
        </View>
      ) : (
        <RowGroup>
          <DataRow label="Name" value={company || '—'} onPress={() => setEditing(true)} />
        </RowGroup>
      )}
      <Text style={[T.caption, { color: p.inkFaint, marginTop: 10, marginHorizontal: 4 }]}>
        The name appears in every header and in every invitation you send.
      </Text>

      <SectionLabel>This app</SectionLabel>
      <RowGroup tone="alt">
        {install.kind === 'promptable' ? (
          <DataRow label="Install on this device" onPress={() => void install.install()} />
        ) : install.kind === 'installed' ? (
          <DataRow label="Installed on this device" value="Yes" />
        ) : install.kind === 'manual' ? (
          <DataRow label="Install on this device" value={install.hint} />
        ) : (
          <DataRow
            label="Platform"
            value={Platform.OS === 'web' ? 'Browser' : Platform.OS === 'ios' ? 'iOS' : 'Android'}
          />
        )}
        <DataRow label="PIN for critical writes" value={pinSet ? 'On' : 'Off'} onPress={() => router.push('/pin')} />
        <DataRow label="Help & safety" onPress={() => router.push('/help')} />
      </RowGroup>

      <SectionLabel>Your account</SectionLabel>
      <RowGroup tone="alt">
        <DataRow label="Signed in as" value={operator ?? '—'} />
        <DataRow label="Role" value="Administrator" />
        <DataRow label="Sign out" level="Warning" onPress={() => signOut()} />
      </RowGroup>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  notice: { borderRadius: radii.card, padding: space.panel, marginTop: 8, marginBottom: 4 },
  form: { borderRadius: radii.card, padding: space.panel, gap: 8 },
  input: { borderRadius: radii.card - 8, borderWidth: 1, paddingHorizontal: 13, paddingVertical: 11 },
  cancel: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
