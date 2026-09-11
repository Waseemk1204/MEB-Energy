import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { useTheme } from '../../src/theme/ThemeProvider';
import { radii, space } from '../../src/theme/tokens';
import { type as T } from '../../src/theme/type';
import { ScreenScaffold } from '../../src/ui/ScreenScaffold';
import { RowGroup, SectionLabel, StatusChip } from '../../src/ui/primitives';
import { api } from '../../src/api/session';
import {
  PERMISSION_HINT,
  PERMISSION_LABEL,
  listUsers,
  permissionsOf,
  removePerson,
  setPermissions,
  setUserStatus,
  type ManagedUser,
  type Permissions,
} from '../../src/api/admin';
import { useSessionStore } from '../../src/store/useSessionStore';
import { logWarn } from '../../src/diagnostics/fieldLog';

/**
 * One person, and what they may do.
 *
 * Each switch is written through to the server immediately rather than
 * collected behind a Save. A permissions screen with a Save button has a state
 * where the switch says one thing and the server believes another, and the
 * person looking at it cannot tell — which for a screen whose whole job is
 * saying what somebody may do is the wrong failure to allow.
 *
 * If a write fails the switch goes back and says why. The server is the truth;
 * this only shows it.
 */
const ORDER: (keyof Permissions)[] = ['read', 'write', 'location', 'health'];

export default function UserDetail() {
  const { p } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const myUserId = useSessionStore((s) => s.operator);

  const [user, setUser] = useState<ManagedUser | null>(null);
  const [perms, setPerms] = useState<Permissions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<keyof Permissions | null>(null);

  useEffect(() => {
    if (!id) return;
    let live = true;

    void (async () => {
      try {
        // No single-user route: the list is already scoped to what this
        // principal may see, so a person they cannot manage is simply absent.
        const found = (await listUsers(api)).find((u) => u.id === id) ?? null;
        if (!live) return;
        setUser(found);
        setPerms(found ? permissionsOf(found) : null);
        setError(found ? null : 'That user is not available.');
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Could not load that user';
        logWarn('ui', 'User detail failed', { message });
        if (live) setError(message);
      }
    })();

    return () => {
      live = false;
    };
  }, [id]);

  const toggle = async (name: keyof Permissions, next: boolean) => {
    if (!perms || !id) return;

    // Moved at once so the switch follows the finger, then put back if the
    // server disagrees. The alternative is a control that lags every tap.
    const before = perms;
    setPerms({ ...perms, [name]: next });
    setSaving(name);
    setError(null);

    try {
      const confirmed = await setPermissions(api, id, { [name]: next });
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

  const isSelf = user !== null && (user.display_name === myUserId || user.email === myUserId);

  /**
   * Removing asks first and names the person. If they have ever changed a
   * parameter the server suspends them instead of deleting: the audit ledger
   * names them, and a ledger entry pointing at nobody is a ledger with a hole
   * in it. The result says which happened.
   */
  const onRemove = () => {
    if (!user) return;
    const who = user.display_name || user.email;
    Alert.alert(
      `Remove ${who}?`,
      'They are signed out everywhere at once and cannot sign in again. If they have made changes to a pack, the account is kept as a record and suspended instead.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
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
          },
        },
      ]
    );
  };

  return (
    <ScreenScaffold
      title={user?.display_name || user?.email || 'User'}
      sub={user?.email ?? 'Loading'}
      right={
        user ? (
          <StatusChip
            tone={user.status === 'active' ? 'good' : 'critical'}
            label={user.status === 'active' ? 'Active' : 'Suspended'}
          />
        ) : undefined
      }
    >
      {error ? (
        <View style={[styles.notice, { backgroundColor: p.panelAlt }]}>
          <Text style={[T.rowLabel, { color: p.critical }]}>{error}</Text>
        </View>
      ) : null}

      {!user || !perms ? (
        error ? null : (
          <View style={styles.loading}>
            <ActivityIndicator color={p.accent} />
          </View>
        )
      ) : (
        <>
          <SectionLabel>What they may do</SectionLabel>

          {isSelf ? (
            <Text style={[T.caption, { color: p.inkSoft, marginBottom: 8 }]}>
              These are your own permissions, so they are shown but not editable.
              Somebody who could grant themselves write would make the setting
              decorative.
            </Text>
          ) : null}

          <RowGroup>
            {ORDER.map((name) => (
              <View key={name} style={styles.row}>
                <View style={{ flexShrink: 1 }}>
                  <Text style={[T.rowLabel, { color: p.inkStrong }]}>
                    {PERMISSION_LABEL[name]}
                  </Text>
                  <Text style={[T.caption, { color: p.inkFaint, marginTop: 1 }]}>
                    {PERMISSION_HINT[name]}
                  </Text>
                </View>
                <Switch
                  value={perms[name]}
                  onValueChange={(next) => void toggle(name, next)}
                  disabled={isSelf || saving !== null}
                  accessibilityLabel={PERMISSION_LABEL[name]}
                  trackColor={{ false: p.panelTrack, true: p.accent }}
                  thumbColor={p.panelBase}
                />
              </View>
            ))}
          </RowGroup>

          <Text style={[T.caption, { color: p.inkFaint, marginTop: 10 }]}>
            Changes take effect on this person’s next request, not at their next
            sign-in.
          </Text>

          <SectionLabel>Account</SectionLabel>
          <RowGroup>
            {!isSelf ? (
              <Pressable
                onPress={onRemove}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${user.display_name || user.email}`}
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
              >
                <View style={{ flexShrink: 1 }}>
                  <Text style={[T.rowLabel, { color: p.critical }]}>Remove from company</Text>
                  <Text style={[T.caption, { color: p.inkFaint, marginTop: 1 }]}>
                    For a guest whose job is done. Asks first.
                  </Text>
                </View>
              </Pressable>
            ) : null}
            <View style={styles.row}>
              <View style={{ flexShrink: 1 }}>
                <Text style={[T.rowLabel, { color: p.inkStrong }]}>Active</Text>
                <Text style={[T.caption, { color: p.inkFaint, marginTop: 1 }]}>
                  Suspending signs them out everywhere at once.
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
          </RowGroup>
        </>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  loading: { paddingVertical: 40, alignItems: 'center' },
  notice: { borderRadius: radii.card, padding: space.panel, marginTop: 8, marginBottom: 4 },
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
