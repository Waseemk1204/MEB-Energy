import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Building2, Cpu, Users, BatteryMedium } from 'lucide-react-native';

import { useTheme } from '../src/theme/ThemeProvider';
import { radii, space } from '../src/theme/tokens';
import { type as T } from '../src/theme/type';
import { ScreenScaffold } from '../src/ui/ScreenScaffold';
import { DataRow, RowGroup, SectionLabel } from '../src/ui/primitives';
import { api } from '../src/api/session';
import { platformOverview, type PlatformOverview } from '../src/api/platform';
import { useSessionStore } from '../src/store/useSessionStore';
import { logWarn } from '../src/diagnostics/fieldLog';

/**
 * Where a platform administrator lands.
 *
 * Totals first, because that is the question an overview answers. The figure
 * that asks for action — companies whose access lapses within the month — is
 * separated out rather than buried in a row of numbers, because it is the only
 * one that means somebody has to do something.
 *
 * The drill-down (company → its users → their batteries) is Phase 4. What is
 * here is real: every number is counted by the server against the database.
 */
export default function AdminHome() {
  const { p } = useTheme();
  const router = useRouter();
  const operator = useSessionStore((s) => s.operator);

  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Nothing is set before the first await, and nothing is set after the
    // screen has gone: a reply arriving to an unmounted component would
    // otherwise update state nobody is showing.
    let live = true;

    void (async () => {
      try {
        const next = await platformOverview(api);
        if (!live) return;
        setOverview(next);
        setError(null);
      } catch (caught) {
        // Named rather than swallowed: an administrator staring at zeros needs
        // to know the difference between an empty platform and a failed
        // request.
        const message = caught instanceof Error ? caught.message : 'Could not load the overview';
        logWarn('ui', 'Overview failed', { message });
        if (live) setError(message);
      }
    })();

    return () => {
      live = false;
    };
  }, []);

  return (
    <ScreenScaffold title="Platform" sub={operator ?? 'Administrator'} back={false}>
      {error ? (
        <View style={[styles.notice, { backgroundColor: p.panelAlt }]}>
          <Text style={[T.rowLabel, { color: p.critical }]}>{error}</Text>
        </View>
      ) : !overview ? (
        <View style={styles.loading}>
          <ActivityIndicator color={p.accent} />
        </View>
      ) : (
        <>
          {/*
           * Lapsing access comes first and on its own. Everything below it
           * describes the platform; this one says which companies stop
           * working next month unless somebody renews them.
           */}
          {overview.companies.lapsingWithin30Days > 0 && (
            <View style={[styles.alert, { backgroundColor: p.panelAlt, borderColor: p.warn }]}>
              <Text style={[T.rowValue, { color: p.warn }]}>
                {overview.companies.lapsingWithin30Days === 1
                  ? '1 company loses access within 30 days'
                  : `${overview.companies.lapsingWithin30Days} companies lose access within 30 days`}
              </Text>
              <Text style={[T.caption, { color: p.inkSoft, marginTop: 4 }]}>
                Renew them from Company management before they stop.
              </Text>
            </View>
          )}

          <SectionLabel>Platform</SectionLabel>
          <View style={styles.tiles}>
            <Tile
              icon={<Building2 size={15} color={p.leatherInkSoft} strokeWidth={2.2} />}
              label="Companies"
              value={overview.companies.total}
              sub={`${overview.companies.withAccess} with access`}
            />
            <Tile
              icon={<Users size={15} color={p.leatherInkSoft} strokeWidth={2.2} />}
              label="Users"
              value={overview.users.total}
              sub={`${overview.users.active} active`}
            />
            <Tile
              icon={<BatteryMedium size={15} color={p.leatherInkSoft} strokeWidth={2.2} />}
              label="Batteries"
              value={overview.batteries.total}
              sub={`${overview.batteries.reportingWithin24Hours} reporting today`}
            />
            <Tile
              icon={<Cpu size={15} color={p.leatherInkSoft} strokeWidth={2.2} />}
              label="Gateways"
              value={overview.gateways.total}
              sub={`${overview.gateways.inService} in service`}
            />
          </View>

          <SectionLabel>Manage</SectionLabel>
          <RowGroup>
            {/* No count here: the tile above already carries it, and the same
                number in two places invites them to disagree. */}
            <DataRow label="Companies" onPress={() => router.push('/batteries')} />
            <DataRow label="Open a pack" onPress={() => router.push('/batteries')} />
          </RowGroup>

          <Text style={[T.caption, { color: p.inkFaint, marginTop: 14 }]}>
            Company management, users and the drill-down arrive next. Every
            figure above is counted by the server, not by this screen.
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
  notice: { borderRadius: radii.card, padding: space.panel, marginTop: 8 },
  alert: {
    borderRadius: radii.card,
    padding: space.panel,
    marginTop: 8,
    marginBottom: 4,
    borderLeftWidth: 3,
  },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: { flexGrow: 1, flexBasis: '46%', borderRadius: radii.card, padding: 14, gap: 2 },
  tileHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
});
