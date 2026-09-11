import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { BatteryMedium, Menu, Users } from 'lucide-react-native';

import { useTheme } from '../../src/theme/ThemeProvider';
import { radii, space } from '../../src/theme/tokens';
import { type as T } from '../../src/theme/type';
import { ScreenScaffold } from '../../src/ui/ScreenScaffold';
import { SideMenu } from '../../src/ui/SideMenu';
import { DataRow, RowGroup, SectionLabel, StatusChip } from '../../src/ui/primitives';
import { api } from '../../src/api/session';
import {
  ENTITLEMENT_LABEL,
  describeRemaining,
  entitlementOf,
  listFleet,
  listUsers,
  type Entitlement,
} from '../../src/api/admin';
import { useSessionStore } from '../../src/store/useSessionStore';
import { logWarn } from '../../src/diagnostics/fieldLog';

/**
 * Where a company owner lands.
 *
 * An owner opens the app to look after their fleet and their people, not to
 * connect to a pack — so the technician's connect sequence is something they
 * choose from here, not something they are dropped into.
 *
 * The access state is shown plainly. An owner whose year is running out
 * should learn it here, from their own home screen, not from a refused
 * sign-in the week after.
 */
export default function CompanyHome() {
  const { p } = useTheme();
  const router = useRouter();
  const company = useSessionStore((s) => s.company);
  const companyId = useSessionStore((s) => s.companyId);
  const operator = useSessionStore((s) => s.operator);

  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
  const [counts, setCounts] = useState<{ packs: number; retired: number; people: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!companyId) return;
    let live = true;

    void (async () => {
      try {
        const [e, fleet, people] = await Promise.all([
          entitlementOf(api, companyId),
          listFleet(api),
          listUsers(api, { companyId }),
        ]);
        if (!live) return;
        setEntitlement(e);
        setCounts({
          packs: fleet.filter((b) => b.status === 'active').length,
          retired: fleet.filter((b) => b.status === 'retired').length,
          // The owner themselves is not "their people".
          people: people.filter((u) => u.role === 'user').length,
        });
        setError(null);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Could not load your company';
        logWarn('ui', 'Company home failed', { message });
        if (live) setError(message);
      }
    })();

    return () => {
      live = false;
    };
  }, [companyId]);

  const menu = (
    <SideMenu
      open={menuOpen}
      onClose={() => setMenuOpen(false)}
      title={company || 'Your company'}
      sub={operator ?? undefined}
      items={[
        {
          label: 'People',
          hint: 'Who works here, and what they may do',
          icon: <Users size={18} color={p.accent} strokeWidth={2.2} />,
          onPress: () => router.push('/company/people'),
        },
        {
          label: 'Fleet',
          hint: 'Your packs: add, edit, retire',
          icon: <BatteryMedium size={18} color={p.accent} strokeWidth={2.2} />,
          onPress: () => router.push('/company/fleet'),
        },
        {
          label: 'Open a pack',
          hint: 'Connect and read one yourself',
          onPress: () => router.push('/batteries'),
        },
        { label: 'Help & safety', onPress: () => router.push('/help') },
      ]}
    />
  );

  return (
    <ScreenScaffold
      title={company || 'Your company'}
      sub={operator ?? 'Company owner'}
      back={false}
      right={
        <Pressable
          onPress={() => setMenuOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Open menu"
          hitSlop={10}
          style={styles.menuButton}
        >
          <Menu size={20} color={p.leatherInk} strokeWidth={2.3} />
        </Pressable>
      }
      overlay={menu}
    >
      {error ? (
        <View style={[styles.notice, { backgroundColor: p.panelAlt }]}>
          <Text style={[T.rowLabel, { color: p.critical }]}>{error}</Text>
        </View>
      ) : null}

      {entitlement ? (
        <View style={[styles.access, { backgroundColor: p.panelAlt }]}>
          <View style={{ flexShrink: 1 }}>
            <Text style={[T.rowValue, { color: p.inkStrong }]}>Access</Text>
            <Text style={[T.caption, { color: p.inkSoft, marginTop: 2 }]}>
              {describeRemaining(entitlement.expiresAt)}
            </Text>
          </View>
          <StatusChip
            tone={entitlement.ok ? 'good' : 'critical'}
            label={ENTITLEMENT_LABEL[entitlement.code]}
          />
        </View>
      ) : null}

      {!counts ? (
        error ? null : (
          <View style={styles.loading}>
            <ActivityIndicator color={p.accent} />
          </View>
        )
      ) : (
        <>
          <SectionLabel>Your company</SectionLabel>
          <RowGroup>
            <DataRow
              label="People"
              value={String(counts.people)}
              onPress={() => router.push('/company/people')}
            />
            <DataRow
              label="Fleet"
              value={
                counts.retired > 0
                  ? `${counts.packs} in service · ${counts.retired} retired`
                  : `${counts.packs} in service`
              }
              onPress={() => router.push('/company/fleet')}
            />
          </RowGroup>

          <SectionLabel>Work</SectionLabel>
          <RowGroup>
            <DataRow label="Open a pack" onPress={() => router.push('/batteries')} />
            <DataRow label="Gateways" onPress={() => router.push('/device')} />
          </RowGroup>
        </>
      )}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  loading: { paddingVertical: 40, alignItems: 'center' },
  notice: { borderRadius: radii.card, padding: space.panel, marginTop: 8, marginBottom: 4 },
  access: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderRadius: radii.card,
    padding: space.panel,
    marginTop: 8,
    marginBottom: 6,
  },
  menuButton: { minWidth: 44, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' },
});
