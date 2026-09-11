import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useTheme } from '../../src/theme/ThemeProvider';
import { radii, space } from '../../src/theme/tokens';
import { type as T } from '../../src/theme/type';
import { ScreenScaffold } from '../../src/ui/ScreenScaffold';
import { PrimaryButton, SectionLabel, StatusChip } from '../../src/ui/primitives';
import { api } from '../../src/api/session';
import {
  ENTITLEMENT_LABEL,
  createCompany,
  describeRemaining,
  entitlementOf,
  grantAccess,
  listCompanies,
  revokeAccess,
  type Company,
  type Entitlement,
} from '../../src/api/admin';
import { logWarn } from '../../src/diagnostics/fieldLog';

/**
 * Company management.
 *
 * Access on and access off is the only commercial control: what a company pays
 * is settled outside the product. So this screen has no seat pickers and no
 * limits — a company either works or it does not, and the row says which.
 *
 * Entitlements are fetched per company rather than joined into the list. That
 * is one request each, which is fine for a platform of tens and would want
 * revisiting at hundreds; the note is here so the day it matters, the reason
 * is already written down.
 */
export default function Companies() {
  const { p } = useTheme();
  const router = useRouter();

  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [access, setAccess] = useState<Record<string, Entitlement>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const rows = await listCompanies(api);
        if (!live) return;
        setCompanies(rows);
        setError(null);

        const entries = await Promise.all(
          rows.map(async (c) => [c.id, await entitlementOf(api, c.id)] as const)
        );
        if (live) setAccess(Object.fromEntries(entries));
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Could not load companies';
        logWarn('ui', 'Companies failed', { message });
        if (live) setError(message);
      }
    })();

    return () => {
      live = false;
    };
  }, [reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  const onCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy('new');
    try {
      await createCompany(api, { name: trimmed });
      setName('');
      setAdding(false);
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create that company');
    } finally {
      setBusy(null);
    }
  };

  const onGrant = async (company: Company) => {
    setBusy(company.id);
    try {
      await grantAccess(api, company.id);
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not grant access');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Revoking stops everybody at that company working, so it asks first. The
   * prompt names the company: "are you sure?" on its own does not tell you
   * which row you tapped.
   */
  const onRevoke = (company: Company) => {
    Alert.alert(
      `Stop access for ${company.name}?`,
      'Everyone there is signed out at their next request, and nobody can sign in until access is granted again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Stop access',
          style: 'destructive',
          onPress: () => {
            setBusy(company.id);
            void revokeAccess(api, company.id)
              .then(reload)
              .catch((caught: unknown) =>
                setError(caught instanceof Error ? caught.message : 'Could not stop access')
              )
              .finally(() => setBusy(null));
          },
        },
      ]
    );
  };

  return (
    <ScreenScaffold
      title="Companies"
      sub={companies ? `${companies.length} on the platform` : 'Loading'}
      right={
        <Pressable
          onPress={() => setAdding((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={adding ? 'Cancel adding a company' : 'Add a company'}
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
          <Text style={[T.sectionLabel, { color: p.inkFaint }]}>Company name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Northern Haulage"
            placeholderTextColor={p.inkFaint}
            accessibilityLabel="Company name"
            style={[
              styles.input,
              { backgroundColor: p.panelBase, color: p.inkStrong, borderColor: p.panelStitch },
            ]}
          />
          <PrimaryButton
            label="Create company"
            onPress={() => void onCreate()}
            disabled={!name.trim() || busy === 'new'}
          />
          <Text style={[T.caption, { color: p.inkSoft }]}>
            Created without access. Grant it when payment is settled.
          </Text>
        </View>
      ) : null}

      {!companies ? (
        <View style={styles.loading}>
          <ActivityIndicator color={p.accent} />
        </View>
      ) : companies.length === 0 ? (
        <Text style={[T.rowLabel, { color: p.inkSoft, marginTop: 16 }]}>
          No companies yet. Add one to begin.
        </Text>
      ) : (
        <>
          <SectionLabel>On the platform</SectionLabel>
          <View style={{ gap: 10 }}>
            {companies.map((c) => {
              const e = access[c.id];
              return (
                <View key={c.id} style={[styles.card, { backgroundColor: p.panelAlt }]}>
                  <Pressable
                    onPress={() => router.push(`/companies/${c.id}`)}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${c.name}`}
                    style={styles.cardHead}
                  >
                    <View style={{ flexShrink: 1 }}>
                      <Text style={[T.rowValue, { color: p.inkStrong }]}>{c.name}</Text>
                      <Text style={[T.caption, { color: p.inkSoft, marginTop: 2 }]}>
                        {e ? describeRemaining(e.expiresAt) : 'Checking access'}
                      </Text>
                    </View>
                    {e ? (
                      <StatusChip
                        tone={e.ok ? 'good' : 'critical'}
                        label={ENTITLEMENT_LABEL[e.code]}
                      />
                    ) : null}
                  </Pressable>

                  <View style={[styles.actions, { borderTopColor: p.panelStitch }]}>
                    {e?.ok ? (
                      <Pressable
                        onPress={() => onRevoke(c)}
                        disabled={busy === c.id}
                        accessibilityRole="button"
                        style={styles.action}
                      >
                        <Text style={[T.tabLabel, { color: p.critical }]}>Stop access</Text>
                      </Pressable>
                    ) : (
                      <Pressable
                        onPress={() => void onGrant(c)}
                        disabled={busy === c.id}
                        accessibilityRole="button"
                        style={styles.action}
                      >
                        <Text style={[T.tabLabel, { color: p.accent }]}>
                          {e && e.code !== 'no_subscription' ? 'Grant again' : 'Grant access'}
                        </Text>
                      </Pressable>
                    )}
                    <Pressable
                      onPress={() => router.push(`/companies/${c.id}`)}
                      accessibilityRole="button"
                      style={styles.action}
                    >
                      <Text style={[T.tabLabel, { color: p.inkSoft }]}>
                        {e ? `${e.seats.used} users` : 'Users'}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
        </>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  loading: { paddingVertical: 40, alignItems: 'center' },
  notice: { borderRadius: radii.card, padding: space.panel, marginTop: 8, marginBottom: 4 },
  add: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  form: { borderRadius: radii.card, padding: space.panel, gap: 9, marginTop: 8, marginBottom: 8 },
  input: { borderRadius: radii.card - 8, borderWidth: 1, paddingHorizontal: 13, paddingVertical: 11 },
  card: { borderRadius: radii.card, overflow: 'hidden' },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: 14,
    minHeight: 64,
  },
  actions: { flexDirection: 'row', borderTopWidth: 1 },
  action: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
