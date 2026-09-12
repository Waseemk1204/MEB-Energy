import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';

import { useTheme } from '../../src/theme/ThemeProvider';
import { radii, space } from '../../src/theme/tokens';
import { type as T } from '../../src/theme/type';
import { ScreenScaffold } from '../../src/ui/ScreenScaffold';
import { DataRow, PrimaryButton, RowGroup, SectionLabel } from '../../src/ui/primitives';
import { api } from '../../src/api/session';
import {
  PERMISSION_HINT,
  PERMISSION_LABEL,
  ROLE_HINT,
  ROLE_LABEL,
  describePerson,
  invitePerson,
  listUsers,
  type Permissions,
  type Role,
} from '../../src/api/company';
import { canShare, inviteMessage } from '../../src/navigation/inviteLink';
import { useSessionStore } from '../../src/store/useSessionStore';
import { useLoad } from '../../src/ui/useLoad';

/**
 * The company's people, and adding to them.
 *
 * Creating somebody asks about their role and their permissions at the same
 * time, because "what may this person do" is part of who they are, not a
 * setting to find afterwards. The defaults are what most people should get —
 * read, location, health — and write is off until somebody decides otherwise.
 * An administrator holds everything, so the switches disappear for one.
 *
 * Nobody is created with a password. They are invited: the administrator gets
 * a link to hand over, the new person sets their own first password, and
 * nobody else ever sees it.
 */
const ORDER: (keyof Permissions)[] = ['read', 'write', 'location', 'health'];
const DEFAULTS: Permissions = { read: true, write: false, location: true, health: true };

export default function People() {
  const { p } = useTheme();
  const router = useRouter();
  const companyName = useSessionStore((s) => s.company);

  const { data: people, error: loadError, reload } = useLoad(() => listUsers(api), [], 'Could not load your people');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('user');
  const [perms, setPerms] = useState<Permissions>(DEFAULTS);
  const [busy, setBusy] = useState(false);

  const canSubmit = name.trim().length > 0 && /\S+@\S+\.\S+/.test(email.trim());

  const onInvite = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await invitePerson(api, {
        email: email.trim(),
        displayName: name.trim(),
        role,
        permissions: role === 'user' ? perms : undefined,
      });

      // The invitation link is returned exactly once. It goes straight to
      // the share sheet rather than into a field, because the whole point is
      // that it reaches the person and is not left lying on this screen.
      // Where there is no share sheet — most desktop browsers — it is copied,
      // and the screen says so.
      if (created.invitation) {
        const message = inviteMessage(companyName, created.invitation.token);
        if (canShare()) {
          await Share.share({ message });
        } else {
          await Clipboard.setStringAsync(message);
          setNotice(
            `Invitation for ${name.trim()} copied. Paste it to them — it works once and expires in 7 days.`
          );
        }
      }

      setName('');
      setEmail('');
      setRole('user');
      setPerms(DEFAULTS);
      setAdding(false);
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not add that person');
    } finally {
      setBusy(false);
    }
  };

  const administrators = (people ?? []).filter((u) => u.role === 'company');
  const technicians = (people ?? []).filter((u) => u.role !== 'company');

  return (
    <ScreenScaffold
      title="People"
      sub={people ? `${people.length} at your company` : 'Loading'}
      right={
        <Pressable
          onPress={() => setAdding((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={adding ? 'Cancel adding a person' : 'Add a person'}
          hitSlop={10}
          style={styles.add}
        >
          <Text style={[T.tabLabel, { color: p.leatherInk }]}>{adding ? 'Cancel' : 'Add'}</Text>
        </Pressable>
      }
    >
      {error || loadError ? (
        <View style={[styles.notice, { backgroundColor: p.panelAlt }]}>
          <Text style={[T.rowLabel, { color: p.critical }]}>{error ?? loadError}</Text>
        </View>
      ) : null}
      {notice ? (
        <View style={[styles.notice, { backgroundColor: p.panelAlt }]} accessibilityRole="alert">
          <Text style={[T.rowLabel, { color: p.inkStrong }]}>{notice}</Text>
        </View>
      ) : null}

      {adding ? (
        <View style={[styles.form, { backgroundColor: p.panelAlt }]}>
          <Text style={[T.sectionLabel, { color: p.inkFaint }]}>Name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Priya Raman"
            placeholderTextColor={p.inkFaint}
            accessibilityLabel="Name"
            autoCapitalize="words"
            style={[styles.input, { backgroundColor: p.panelBase, color: p.inkStrong, borderColor: p.panelStitch }]}
          />
          <Text style={[T.sectionLabel, { color: p.inkFaint }]}>Email</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="priya@yourcompany.example"
            placeholderTextColor={p.inkFaint}
            accessibilityLabel="Email"
            autoCapitalize="none"
            keyboardType="email-address"
            style={[styles.input, { backgroundColor: p.panelBase, color: p.inkStrong, borderColor: p.panelStitch }]}
          />

          <Text style={[T.sectionLabel, { color: p.inkFaint, marginTop: 6 }]}>Role</Text>
          <View style={styles.roles}>
            {(['user', 'company'] as Role[]).map((r) => {
              const selected = role === r;
              return (
                <Pressable
                  key={r}
                  onPress={() => setRole(r)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={ROLE_LABEL[r]}
                  style={[
                    styles.role,
                    {
                      backgroundColor: selected ? p.accent : p.panelBase,
                      borderColor: selected ? p.accent : p.panelStitch,
                    },
                  ]}
                >
                  <Text style={[T.rowLabel, { color: selected ? p.panelBase : p.inkStrong }]}>
                    {ROLE_LABEL[r]}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={[T.caption, { color: p.inkFaint }]}>{ROLE_HINT[role]}</Text>

          {role === 'user' ? (
            <>
              <Text style={[T.sectionLabel, { color: p.inkFaint, marginTop: 6 }]}>What they may do</Text>
              {ORDER.map((key) => (
                <View key={key} style={styles.permRow}>
                  <View style={{ flexShrink: 1 }}>
                    <Text style={[T.rowLabel, { color: p.inkStrong }]}>{PERMISSION_LABEL[key]}</Text>
                    <Text style={[T.caption, { color: p.inkFaint }]}>{PERMISSION_HINT[key]}</Text>
                  </View>
                  <Switch
                    value={perms[key]}
                    onValueChange={(next) => setPerms({ ...perms, [key]: next })}
                    accessibilityLabel={PERMISSION_LABEL[key]}
                    trackColor={{ false: p.panelTrack, true: p.accent }}
                    thumbColor={p.panelBase}
                  />
                </View>
              ))}
            </>
          ) : null}

          <PrimaryButton
            label={busy ? 'Adding…' : 'Add and send invitation'}
            onPress={() => void onInvite()}
            disabled={!canSubmit || busy}
          />
          <Text style={[T.caption, { color: p.inkSoft }]}>
            They set their own password from the link. You never see it.
          </Text>
        </View>
      ) : null}

      {!people ? (
        loadError ? null : (
          <View style={styles.loading}>
            <ActivityIndicator color={p.accent} />
          </View>
        )
      ) : people.length === 0 ? (
        <Text style={[T.rowLabel, { color: p.inkSoft, marginTop: 16 }]}>
          Nobody yet. Add your first technician.
        </Text>
      ) : (
        <>
          {administrators.length > 0 ? (
            <>
              <SectionLabel>Administrators</SectionLabel>
              <RowGroup>
                {administrators.map((u) => (
                  <DataRow
                    key={u.id}
                    label={u.display_name || u.email}
                    value={describePerson(u)}
                    onPress={() => router.push(`/users/${u.id}`)}
                  />
                ))}
              </RowGroup>
            </>
          ) : null}

          <SectionLabel>
            {technicians.length === 0 ? 'No technicians yet' : 'Technicians'}
          </SectionLabel>
          {technicians.length > 0 ? (
            <RowGroup>
              {technicians.map((u) => (
                <DataRow
                  key={u.id}
                  label={u.display_name || u.email}
                  value={describePerson(u)}
                  onPress={() => router.push(`/users/${u.id}`)}
                />
              ))}
            </RowGroup>
          ) : null}
          <Text style={[T.caption, { color: p.inkFaint, marginTop: 10 }]}>
            Tap somebody to change their details, what they may do, or to remove them.
          </Text>
        </>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  loading: { paddingVertical: 40, alignItems: 'center' },
  notice: { borderRadius: radii.card, padding: space.panel, marginTop: 8, marginBottom: 4 },
  add: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  form: { borderRadius: radii.card, padding: space.panel, gap: 8, marginTop: 8, marginBottom: 8 },
  input: { borderRadius: radii.card - 8, borderWidth: 1, paddingHorizontal: 13, paddingVertical: 11 },
  roles: { flexDirection: 'row', gap: 8 },
  role: {
    flex: 1,
    minHeight: 44,
    borderRadius: radii.card - 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  permRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 48,
  },
});
