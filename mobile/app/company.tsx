import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useTheme } from '../src/theme/ThemeProvider';
import { radii, space } from '../src/theme/tokens';
import { type as T } from '../src/theme/type';
import { ScreenScaffold } from '../src/ui/ScreenScaffold';
import { DataRow, RowGroup, SectionLabel } from '../src/ui/primitives';
import { useSessionStore } from '../src/store/useSessionStore';

/**
 * Where a company owner lands.
 *
 * An owner opens the app to look after their fleet and their people, not to
 * connect to a pack — so the technician's connect sequence is something they
 * choose, not something they are dropped into.
 *
 * Battery and user management are Phase 5. This screen says plainly what is
 * here and what is not, rather than showing controls that do nothing.
 */
export default function CompanyHome() {
  const { p } = useTheme();
  const router = useRouter();
  const company = useSessionStore((s) => s.company);
  const operator = useSessionStore((s) => s.operator);

  return (
    <ScreenScaffold
      title={company || 'Your company'}
      sub={operator ?? 'Company owner'}
      back={false}
    >
      <SectionLabel>Fleet</SectionLabel>
      <RowGroup>
        <DataRow label="Batteries" onPress={() => router.push('/batteries')} />
        <DataRow label="Gateways" onPress={() => router.push('/device')} />
      </RowGroup>

      <SectionLabel>Account</SectionLabel>
      <RowGroup>
        <DataRow label="Help &amp; safety" onPress={() => router.push('/help')} />
      </RowGroup>

      <View style={[styles.notice, { backgroundColor: p.panelAlt }]}>
        <Text style={[T.rowValue, { color: p.inkStrong }]}>Coming next</Text>
        <Text style={[T.caption, { color: p.inkSoft, marginTop: 5 }]}>
          Adding and removing your own users, and deciding for each of them
          whether they may write parameters, see locations and see health
          history. The permissions themselves are already enforced by the
          server; this is the screen that sets them.
        </Text>
      </View>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  notice: { borderRadius: radii.card, padding: space.panel, marginTop: 18 },
});
