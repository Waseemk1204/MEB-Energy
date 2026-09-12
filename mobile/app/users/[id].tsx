import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { useTheme } from '../../src/theme/ThemeProvider';
import { radii, space } from '../../src/theme/tokens';
import { type as T } from '../../src/theme/type';
import { ScreenScaffold } from '../../src/ui/ScreenScaffold';
import { confirmDestructive } from '../../src/ui/confirm';
import { PrimaryButton, RowGroup, SectionLabel, StatusChip } from '../../src/ui/primitives';
import { api } from '../../src/api/session';
import {
  PERMISSION_HINT,
  PERMISSION_LABEL,
  ROLE_LABEL,
  STATUS_LABEL,
  editPerson,
  listUsers,
  permissionsOf,
  removePerson,
  setPermissions,
  setUserStatus,
  type ManagedUser,
  type Permissions,
} from '../../src/api/company';
import { useSessionStore } from '../../src/store/useSessionStore';
import { useLoad } from '../../src/ui/useLoad';

/**
 * One person: who they are, what they may do, and whether they are active.
 *
 * Each permission switch is written through to the server immediately rather
 * than collected behind a Save. A permissions screen with a Save button has a
 * state where the switch says one thing and the server believes another, and
 * the person looking at it cannot tell — which for a screen whose whole job
 * is saying what somebody may do is the wrong failure to allow.
 *
 * Name and email do have a Save, because a half-typed name is not a state
 * worth sending. If a write fails the control goes back and says why. The
 * server is the truth; this only shows it.
 */
const ORDER: (keyof Permissions)[] = ['read', 'write', 'location', 'health'];

export default function UserDetail() {
  const { p } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const myName = useSessionStore((s) => s.operator);

  // No single-user route: the list is already scoped to what this principal
  // may see, so a person they cannot manage is simply absent.
  // Wrapped, so that "still loading" (null) and "no such person" (found:
  // null) are different answers.
  const { data: fetched, error: loadError } = useLoad(
    async () => ({ found: id ? ((await listUsers(api)).find((u) => u.id === id) ?? null) : null }),
    [id],
    'Could not load that user'
  );
  const loaded = fetched?.found ?? null;

  /*
   * What the server loaded, plus whatever this screen has since changed and
   * had confirmed. Kept as an overlay rather than a copy so the loaded person
   * never has to be copied into state in an effect.
   */
  const [changed, setChanged] = useState<Partial<ManagedUser>>({});
  const [permsChanged, setPermsChanged] = useState<Permissions | null>(null);
  const user: ManagedUser | null = loaded ? { ...loaded, ...changed } : null;
  const perms: Permissions | null = permsChanged ?? (loaded ? permissionsOf(loaded) : null);
  const setUser = (next: ManagedUser) => setChanged({ ...changed, ...next });
  const setPerms = (next: Permissions) => setPermsChanged(next);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState<keyof Permissions | 'details' | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  const notFound = loadError ?? (fetched && fetched.found === null ? 'That user is not available.' : null);

  const beginEditing = () => {
    if (!user) return;
    setName(user.display_name);
    setEmail(user.email);
    setEditing(true);
  };

  const toggle = async (key: keyof Permissions, next: boolean) => {
    if (!perms || !id) return;

    // Moved at once so the switch follows the finger, then put back if the
    // server disagrees. The alternative is a control that lags every tap.
    const before = perms;
    setPerms({ ...perms, [key]: next });
    setSaving(key);
    setError(null);

    try {
      const confirmed = await setPermissions(api, id, { [key]: next });
      setPerms(confirmed);
    } catch (caught) {
      setPerms(before);
      setError(caught instanceof Error ? caught.message : 'That change was refused');
    } finally {
      setSaving(null);
    }
  };

  const onStatus = async (next: 'active' | 'suspended') => {
    if (!user) return;
    try {
      await setUserStatus(api, user.id, next);
      setUser({ ...user, status: next });
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not change that');
    }
  };

  const canSaveDetails =
    name.trim().length > 0 &&
    /\S+@\S+\.\S+/.test(email.trim()) &&
    user !== null &&
    (name.trim() !== user.display_name || email.trim().toLowerCase() !== user.email);

  const onSaveDetails = async () => {
    if (!user || !canSaveDetails) return;
    setSaving('details');
    setError(null);
    try {
      const patch: { displayName?: string; email?: string } = {};
      if (name.trim() !== user.display_name) patch.displayName = name.trim();
      if (email.trim().toLowerCase() !== user.email) patch.email = email.trim();
      await editPerson(api, user.id, patch);
      setUser({ ...user, display_name: name.trim(), email: email.trim().toLowerCase() });
      setEditing(false);
      setNotice('Saved.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save those details');
    } finally {
      setSaving(null);
    }
  };

  const isSelf = user !== null && (user.display_name === myName || user.email === myName);
  const isAdministrator = user?.role === 'company';

  /**
   * Removing asks first and names the person. If they have ever changed a
   * parameter the server suspends them instead of deleting: the audit ledger
   * names them, and a ledger entry pointing at nobody is a ledger with a hole
   * in it. The result says which happened.
   */
  const onRemove = () => {
    if (!user) return;
    const who = user.display_name || user.email;
    confirmDestructive(
      `Remove ${who}?`,
      'They are signed out everywhere at once and cannot sign in again. If they have made changes to a pack, the account is kept as a record and suspended instead.',
      'Remove',
      () => {
        void removePerson(api, user.id)
          .then((result) => {
            if (result.removed) {
              router.back();
            } else {
              setUser({ ...user, status: 'suspended' });
              setError(`${who} has changed packs before, so the account was suspended and kept as a record.`);
            }
          })
          .catch((caught: unknown) =>
            setError(caught instanceof Error ? caught.message : 'Could not remove them')
          );
      }
    );
  };

  return (
    <ScreenScaffold
      title={user?.display_name || user?.email || 'User'}
      sub={user ? `${ROLE_LABEL[user.role]} · ${user.email}` : 'Loading'}
      right={
        user ? (
          <StatusChip
            tone={user.status === 'active' ? 'good' : user.status === 'invited' ? 'warn' : 'critical'}
            label={STATUS_LABEL[user.status] ?? user.status}
          />
        ) : undefined
      }
    >
      {error || notFound ? (
        <View style={[styles.notice, { backgroundColor: p.panelAlt }]}>
          <Text style={[T.rowLabel, { color: p.critical }]}>{error ?? notFound}</Text>
        </View>
      ) : null}
      {notice ? (
        <View style={[styles.notice, { backgroundColor: p.panelAlt }]}>
          <Text style={[T.rowLabel, { color: p.inkStrong }]}>{notice}</Text>
        </View>
      ) : null}

      {!user || !perms ? (
        notFound ? null : (
          <View style={styles.loading}>
            <ActivityIndicator color={p.accent} />
          </View>
        )
      ) : (
        <>
          <SectionLabel>Details</SectionLabel>
          {editing ? (
            <View style={[styles.form, { backgroundColor: p.panelAlt }]}>
              <Text style={[T.sectionLabel, { color: p.inkFaint }]}>Name</Text>
              <TextInput
                value={name}
                onChangeText={setName}
                accessibilityLabel="Name"
                autoCapitalize="words"
                style={[styles.input, { backgroundColor: p.panelBase, color: p.inkStrong, borderColor: p.panelStitch }]}
              />
              <Text style={[T.sectionLabel, { color: p.inkFaint }]}>Email</Text>
              <TextInput
                value={email}
                onChangeText={setEmail}
                accessibilityLabel="Email"
                autoCapitalize="none"
                keyboardType="email-address"
                style={[styles.input, { backgroundColor: p.panelBase, color: p.inkStrong, borderColor: p.panelStitch }]}
              />
              <PrimaryButton
                label={saving === 'details' ? 'Saving…' : 'Save details'}
                onPress={() => void onSaveDetails()}
                disabled={!canSaveDetails || saving !== null}
              />
              <Pressable
                onPress={() => setEditing(false)}
                accessibilityRole="button"
                style={styles.cancel}
              >
                <Text style={[T.tabLabel, { color: p.inkSoft }]}>Cancel</Text>
              </Pressable>
            </View>
          ) : (
            <RowGroup>
              <Pressable
                onPress={beginEditing}
                accessibilityRole="button"
                accessibilityLabel="Edit name and email"
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
              >
                <View style={{ flexShrink: 1 }}>
                  <Text style={[T.rowLabel, { color: p.inkStrong }]}>{user.display_name}</Text>
                  <Text style={[T.caption, { color: p.inkFaint, marginTop: 1 }]}>{user.email}</Text>
                </View>
                <Text style={[T.tabLabel, { color: p.accent }]}>Edit</Text>
              </Pressable>
            </RowGroup>
          )}

          <SectionLabel>What they may do</SectionLabel>

          {isAdministrator ? (
            <View style={[styles.notice, { backgroundColor: p.panelAlt, marginTop: 0 }]}>
              <Text style={[T.rowLabel, { color: p.inkStrong }]}>Everything.</Text>
              <Text style={[T.caption, { color: p.inkSoft, marginTop: 4 }]}>
                An administrator holds every permission: they read every pack, change
                parameters, see location and health, manage people and open remote
                support. There is nothing to switch off short of suspending the account.
              </Text>
            </View>
          ) : (
            <>
              {isSelf ? (
                <Text style={[T.caption, { color: p.inkSoft, marginBottom: 8 }]}>
                  These are your own permissions, so they are shown but not editable.
                </Text>
              ) : null}
              <RowGroup>
                {ORDER.map((key) => (
                  <View key={key} style={styles.row}>
                    <View style={{ flexShrink: 1 }}>
                      <Text style={[T.rowLabel, { color: p.inkStrong }]}>{PERMISSION_LABEL[key]}</Text>
                      <Text style={[T.caption, { color: p.inkFaint, marginTop: 1 }]}>
                        {PERMISSION_HINT[key]}
                      </Text>
                    </View>
                    <Switch
                      value={perms[key]}
                      onValueChange={(next) => void toggle(key, next)}
                      disabled={isSelf || saving !== null}
                      accessibilityLabel={PERMISSION_LABEL[key]}
                      trackColor={{ false: p.panelTrack, true: p.accent }}
                      thumbColor={p.panelBase}
                    />
                  </View>
                ))}
              </RowGroup>
              <Text style={[T.caption, { color: p.inkFaint, marginTop: 10 }]}>
                Changes take effect on this person’s next request, not at their next sign-in.
              </Text>
            </>
          )}

          <SectionLabel>Account</SectionLabel>
          <RowGroup>
            {user.status === 'invited' ? (
              <View style={styles.row}>
                <View style={{ flexShrink: 1 }}>
                  <Text style={[T.rowLabel, { color: p.inkStrong }]}>Invitation not accepted</Text>
                  <Text style={[T.caption, { color: p.inkFaint, marginTop: 1 }]}>
                    They have not set a password yet. Remove them to cancel the invitation.
                  </Text>
                </View>
              </View>
            ) : (
              <View style={styles.row}>
                <View style={{ flexShrink: 1 }}>
                  <Text style={[T.rowLabel, { color: p.inkStrong }]}>Active</Text>
                  <Text style={[T.caption, { color: p.inkFaint, marginTop: 1 }]}>
                    Deactivating signs them out everywhere at once.
                  </Text>
                </View>
                <Switch
                  value={user.status === 'active'}
                  onValueChange={(next) => void onStatus(next ? 'active' : 'suspended')}
                  disabled={isSelf}
                  accessibilityLabel="Account active"
                  trackColor={{ false: p.panelTrack, true: p.accent }}
                  thumbColor={p.panelBase}
                />
              </View>
            )}
            {!isSelf ? (
              <Pressable
                onPress={onRemove}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${user.display_name || user.email}`}
                style={({ pressed }) => [
                  styles.row,
                  { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.panelStitch },
                  pressed && { opacity: 0.6 },
                ]}
              >
                <View style={{ flexShrink: 1 }}>
                  <Text style={[T.rowLabel, { color: p.critical }]}>Remove from company</Text>
                  <Text style={[T.caption, { color: p.inkFaint, marginTop: 1 }]}>
                    For a guest whose job is done. Asks first.
                  </Text>
                </View>
              </Pressable>
            ) : null}
          </RowGroup>
        </>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  loading: { paddingVertical: 40, alignItems: 'center' },
  notice: { borderRadius: radii.card, padding: space.panel, marginTop: 8, marginBottom: 4 },
  form: { borderRadius: radii.card, padding: space.panel, gap: 8 },
  input: { borderRadius: radii.card - 8, borderWidth: 1, paddingHorizontal: 13, paddingVertical: 11 },
  cancel: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 56,
  },
});
