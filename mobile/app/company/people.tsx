import React, { useEffect, useState } from 'react';
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

import { useTheme } from '../../src/theme/ThemeProvider';
import { radii, space } from '../../src/theme/tokens';
import { type as T } from '../../src/theme/type';
import { ScreenScaffold } from '../../src/ui/ScreenScaffold';
import { DataRow, PrimaryButton, RowGroup, SectionLabel } from '../../src/ui/primitives';
import { api } from '../../src/api/session';
import {
  PERMISSION_HINT,
  PERMISSION_LABEL,
  invitePerson,
  listUsers,
  permissionsOf,
  type ManagedUser,
  type Permissions,
} from '../../src/api/admin';
import { useSessionStore } from '../../src/store/useSessionStore';
import { logWarn } from '../../src/diagnostics/fieldLog';

/**
 * A company's people, and adding to them.
 *
 * Creating somebody asks about their permissions at the same time, because
 * "what may this person do" is part of who they are, not a setting to find
 * afterwards. The defaults are what most people should get — read, location,
 * health — and write is off until somebody decides otherwise.
 *
 * Nobody is created with a password. They are invited: the owner gets a link
 * to hand over, the new person sets their own first password, and nobody else
 * ever sees it.
 */
const ORDER: (keyof Permissions)[] = ['read', 'write', 'location', 'health'];
const DEFAULTS: Permissions = { read: true, write: false, location: true, health: true };

export default function People() {
  const { p } = useTheme();
  const router = useRouter();
  const companyId = useSessionStore((s) => s.companyId);

  const [people, setPeople] = useState<ManagedUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [perms, setPerms] = useState<Permissions>(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!companyId) return;
    let live = true;

    void (async () => {
      try {
        const rows = await listUsers(api, { companyId });
        if (!live) return;
        setPeople(rows.filter((u) => u.role === 'user'));
        setError(null);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Could not load your people';
        logWarn('ui', 'People failed', { message });
        if (live) setError(message);
      }
    })();

    return () => {
      live = false;
    };
  }, [companyId, reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);
  const canSubmit = name.trim().length > 0 && /\S+@\S+\.\S+/.test(email.trim());

  const onInvite = async () => {
    if (!companyId || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const created = await invitePerson(api, {
        companyId,
        email: email.trim(),
        displayName: name.trim(),
        permissions: perms,
      });

      // The invitation link is returned exactly once. It goes straight to
      // the share sheet rather than into a field, because the whole point is
      // that it reaches the person and is not left lying on this screen.
      if (created.invitation) {
        await Share.share({
          message:
            `You have been added to KnowyourEV. Set your password here: ` +
            `knowyourev://accept-invite?token=${created.invitation.token}`,
        });
      }

      setName('');
      setEmail('');
      setPerms(DEFAULTS);
      setAdding(false);
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not add that person');
    } finally {
      setBusy(false);
    }
  };

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
      {error ? (
        <View style={[styles.notice, { backgroundColor: p.panelAlt }]}>
          <Text style={[T.rowLabel, { color: p.critical }]}>{error}</Text>
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
        error ? null : (
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
          <SectionLabel>At your company</SectionLabel>
          <RowGroup>
            {people.map((u) => {
              const pm = permissionsOf(u);
              const summary =
                u.status !== 'active'
                  ? u.status
                  : [pm.read && 'read', pm.write && 'write', pm.location && 'location', pm.health && 'health']
                      .filter(Boolean)
                      .join(' · ') || 'nothing';
              return (
                <DataRow
                  key={u.id}
                  label={u.display_name || u.email}
                  value={summary}
                  onPress={() => router.push(`/users/${u.id}`)}
                />
              );
            })}
          </RowGroup>
          <Text style={[T.caption, { color: p.inkFaint, marginTop: 10 }]}>
            Tap somebody to change what they may do, or to remove them.
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
  permRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 48,
  },
});
