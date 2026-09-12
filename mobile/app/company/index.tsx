import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  BatteryMedium,
  Cpu,
  FileClock,
  Menu,
  Radio,
  Settings as SettingsIcon,
  Users,
} from 'lucide-react-native';

import { useTheme } from '../../src/theme/ThemeProvider';
import { radii, space } from '../../src/theme/tokens';
import { type as T } from '../../src/theme/type';
import { ScreenScaffold } from '../../src/ui/ScreenScaffold';
import { SideMenu } from '../../src/ui/SideMenu';
import { DataRow, RowGroup, SectionLabel } from '../../src/ui/primitives';
import { api } from '../../src/api/session';
import { fetchCompany } from '../../src/api/company';
import { useLoad } from '../../src/ui/useLoad';
import { useSessionStore } from '../../src/store/useSessionStore';

/**
 * Where an administrator lands.
 *
 * An administrator opens the app to look after the fleet and the people, not
 * to connect to a pack — so the technician's connect sequence is something
 * they choose from here, not something they are dropped into.
 *
 * Every number is counted by the server against the database, not by this
 * screen from a list that may be paged.
 */
export default function CompanyHome() {
  const { p } = useTheme();
  const router = useRouter();
  const companyName = useSessionStore((s) => s.company);
  const operator = useSessionStore((s) => s.operator);

  const [menuOpen, setMenuOpen] = useState(false);
  // Named rather than swallowed: an administrator staring at zeros needs to
  // know the difference between an empty company and a failed request.
  const { data: company, error, reload } = useLoad(() => fetchCompany(api), [], 'Could not load your company');

  // The header name may have been renamed since sign-in.
  useEffect(() => {
    if (company?.name && company.name !== useSessionStore.getState().company) {
      useSessionStore.setState({ company: company.name });
    }
  }, [company]);

  const title = company?.name || companyName || 'Your company';

  const menu = (
    <SideMenu
      open={menuOpen}
      onClose={() => setMenuOpen(false)}
      title={title}
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
          label: 'Gateways',
          hint: 'Hardware and its security state',
          icon: <Cpu size={18} color={p.accent} strokeWidth={2.2} />,
          onPress: () => router.push('/company/gateways'),
        },
        {
          label: 'Remote support',
          hint: 'Change a parameter on a pack a technician is at',
          icon: <Radio size={18} color={p.accent} strokeWidth={2.2} />,
          onPress: () => router.push('/company/support'),
        },
        {
          label: 'Ledger',
          hint: 'Every change on every pack, by everyone',
          icon: <FileClock size={18} color={p.accent} strokeWidth={2.2} />,
          onPress: () => router.push('/company/ledger'),
        },
        {
          label: 'Open a pack',
          hint: 'Connect and read one yourself',
          onPress: () => router.push('/batteries'),
        },
        {
          label: 'Company settings',
          hint: 'Name, your account, sign out',
          icon: <SettingsIcon size={18} color={p.accent} strokeWidth={2.2} />,
          onPress: () => router.push('/company/settings'),
        },
        { label: 'Help & safety', onPress: () => router.push('/help') },
      ]}
    />
  );

  const o = company?.overview;

  return (
    <ScreenScaffold
      title={title}
      sub={operator ?? 'Administrator'}
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
          <Pressable onPress={reload} accessibilityRole="button" style={{ marginTop: 8 }}>
            <Text style={[T.tabLabel, { color: p.accent }]}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {!o ? (
        error ? null : (
          <View style={styles.loading}>
            <ActivityIndicator color={p.accent} />
          </View>
        )
      ) : (
        <>
          <SectionLabel>At a glance</SectionLabel>
          <View style={styles.tiles}>
            <Tile
              icon={<Users size={15} color={p.leatherInkSoft} strokeWidth={2.2} />}
              label="People"
              value={o.people.active}
              sub={
                o.people.invited > 0
                  ? `${o.people.invited} invited · ${o.people.administrators} admin`
                  : `${o.people.administrators} administrator${o.people.administrators === 1 ? '' : 's'}`
              }
            />
            <Tile
              icon={<BatteryMedium size={15} color={p.leatherInkSoft} strokeWidth={2.2} />}
              label="Packs"
              value={o.batteries.inService}
              sub={`${o.batteries.reportingWithin24Hours} reporting today`}
            />
            <Tile
              icon={<Cpu size={15} color={p.leatherInkSoft} strokeWidth={2.2} />}
              label="Gateways"
              value={o.gateways.total}
              sub={`${o.gateways.inService} in service`}
            />
          </View>

          <SectionLabel>Your company</SectionLabel>
          <RowGroup>
            <DataRow label="People" onPress={() => router.push('/company/people')} />
            <DataRow
              label="Fleet"
              value={
                o.batteries.total > o.batteries.inService
                  ? `${o.batteries.total - o.batteries.inService} retired`
                  : undefined
              }
              onPress={() => router.push('/company/fleet')}
            />
            <DataRow label="Gateways" onPress={() => router.push('/company/gateways')} />
          </RowGroup>

          <SectionLabel>Work</SectionLabel>
          <RowGroup>
            <DataRow label="Open a pack" onPress={() => router.push('/batteries')} />
            <DataRow label="Remote support" onPress={() => router.push('/company/support')} />
            <DataRow label="Ledger" onPress={() => router.push('/company/ledger')} />
          </RowGroup>

          <Text style={[T.caption, { color: p.inkFaint, marginTop: 14 }]}>
            Every figure above is counted by the server, not by this screen.
          </Text>
        </>
      )}
    </ScreenScaffold>
  );
}

/**
 * One number and what it is. Big-number tiles only earn their space when the
 * figures are the point of the screen, which on an overview they are.
 */
function Tile({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  sub: string;
}) {
  const { p } = useTheme();
  return (
    <View style={[styles.tile, { backgroundColor: p.panelAlt }]}>
      <View style={styles.tileHead}>
        {icon}
        <Text style={[T.tabLabel, { color: p.inkFaint }]}>{label}</Text>
      </View>
      <Text style={[T.metricValue, { color: p.inkStrong, fontSize: 30 }]}>{value}</Text>
      <Text style={[T.caption, { color: p.inkSoft }]}>{sub}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { paddingVertical: 40, alignItems: 'center' },
  notice: { borderRadius: radii.card, padding: space.panel, marginTop: 8, marginBottom: 4 },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: { flexGrow: 1, flexBasis: '30%', borderRadius: radii.card, padding: 14, gap: 2 },
  tileHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  menuButton: { minWidth: 44, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' },
});
