import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { useTheme } from '../../src/theme/ThemeProvider';
import { radii, space } from '../../src/theme/tokens';
import { type as T } from '../../src/theme/type';
import { ScreenScaffold } from '../../src/ui/ScreenScaffold';
import { DataRow, RowGroup, SectionLabel, StatusChip } from '../../src/ui/primitives';
import { api } from '../../src/api/session';
import {
  ENTITLEMENT_LABEL,
  describeRemaining,
  entitlementOf,
  listCompanies,
  listUsers,
  permissionsOf,
  type Company,
  type Entitlement,
  type ManagedUser,
} from '../../src/api/admin';
import { logWarn } from '../../src/diagnostics/fieldLog';

/**
 * One company: its people, and what it has.
 *
 * The people come first. Batteries and gateways are counted rather than
 * listed, because the question this screen answers is "who is at this company
 * and what may they do" — the packs themselves belong to the fleet screens.
 */
export default function CompanyDetail() {
  const { p } = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [company, setCompany] = useState<Company | null>(null);
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let live = true;

    void (async () => {
      try {
        const [companies, e, people] = await Promise.all([
          listCompanies(api),
          entitlementOf(api, id),
          listUsers(api, { companyId: id }),
        ]);
        if (!live) return;
        setCompany(companies.find((c) => c.id === id) ?? null);
        setEntitlement(e);
        setUsers(people);
        setError(null);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Could not load that company';
        logWarn('ui', 'Company detail failed', { message });
        if (live) setError(message);
      }
    })();

    return () => {
      live = false;
    };
  }, [id]);

  const summary = (n: number, one: string, many: string) =>
    `${n} ${n === 1 ? one : many}`;

  return (
    <ScreenScaffold
      title={company?.name ?? 'Company'}
      sub={entitlement ? describeRemaining(entitlement.expiresAt) : 'Loading'}
      right={
        entitlement ? (
          <StatusChip
            tone={entitlement.ok ? 'good' : 'critical'}
            label={ENTITLEMENT_LABEL[entitlement.code]}
          />
        ) : undefined
      }
    >
      {error ? (
        <View style={[styles.notice, { backgroundColor: p.panelAlt }]}>
          <Text style={[T.rowLabel, { color: p.critical }]}>{error}</Text>
        </View>
      ) : !users || !entitlement ? (
        <View style={styles.loading}>
          <ActivityIndicator color={p.accent} />
        </View>
      ) : (
        <>
          <SectionLabel>What they have</SectionLabel>
          <RowGroup>
            <DataRow
              label="Batteries"
              value={summary(entitlement.batteries.used, 'pack', 'packs')}
            />
            <DataRow
              label="Gateways"
              value={summary(entitlement.devices.used, 'gateway', 'gateways')}
            />
            <DataRow
              label="Owner sign-ins"
              value={`${entitlement.sessionDevices.used} of ${entitlement.sessionDevices.limit ?? '—'} devices`}
            />
          </RowGroup>

          <SectionLabel>
            {users.length === 0 ? 'Nobody yet' : summary(users.length, 'person', 'people')}
          </SectionLabel>

          {users.length === 0 ? (
            <Text style={[T.caption, { color: p.inkSoft }]}>
              This company has not added anyone. They create their own users.
            </Text>
          ) : (
            <RowGroup>
              {users.map((u) => {
                const perms = permissionsOf(u);
                // What they may do, said in the row rather than a screen down.
                const granted = [
                  perms.read && 'read',
                  perms.write && 'write',
                  perms.location && 'location',
                  perms.health && 'health',
                ].filter(Boolean) as string[];

                return (
                  <DataRow
                    key={u.id}
                    label={u.display_name || u.email}
                    value={u.status === 'active' ? granted.join(' · ') || 'nothing' : u.status}
                    onPress={() => router.push(`/users/${u.id}`)}
                  />
                );
              })}
            </RowGroup>
          )}
        </>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  loading: { paddingVertical: 40, alignItems: 'center' },
  notice: { borderRadius: radii.card, padding: space.panel, marginTop: 8 },
});
