import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../../src/theme/ThemeProvider';
import { radii, space } from '../../src/theme/tokens';
import { type as T } from '../../src/theme/type';
import { ScreenScaffold } from '../../src/ui/ScreenScaffold';
import { SectionLabel, StatusChip } from '../../src/ui/primitives';
import { api } from '../../src/api/session';
import {
  DEFAULT_LEDGER_ROWS,
  RESULT_LABEL,
  RESULT_TONE,
  SOURCE_LABEL,
  describeChange,
  formatWhen,
  listLedger,
  wasUploadedLate,
  type LedgerFilter,
  type WriteResult,
  type WriteSource,
} from '../../src/api/ledger';
import { listFleet, listUsers } from '../../src/api/company';
import { useLoad } from '../../src/ui/useLoad';

/**
 * The company's audit ledger: every change on every pack, by everyone.
 *
 * Refusals are shown, not filtered out — a trail of successes cannot answer
 * "what did someone try to do". And the filters are sent to the server, not
 * applied here: the server returns the newest 200, and narrowing that page
 * locally would report "nothing changed" about a pack whose changes are
 * simply older than the page.
 */
const SOURCES: (WriteSource | undefined)[] = [undefined, 'local', 'admin_remote', 'admin_force_push'];
const RESULTS: (WriteResult | undefined)[] = [undefined, 'success', 'adjusted', 'rejected', 'timeout', 'indeterminate'];

export default function Ledger() {
  const { p } = useTheme();

  const [filter, setFilter] = useState<LedgerFilter>({});

  // Names for the ids the ledger carries. Loaded once; the ledger itself
  // reloads per filter. A failure here leaves ids showing, which is still
  // the truth.
  const { data: names } = useLoad(
    async () => {
      const [packs, people] = await Promise.all([listFleet(api), listUsers(api)]);
      return { packs, people };
    },
    [],
    'Could not load names'
  );
  const packs = names?.packs ?? [];
  const people = names?.people ?? [];

  const { data: events, error } = useLoad(
    () => listLedger(api, filter),
    [filter],
    'Could not load the ledger'
  );

  const packSerial = (id: string | null) =>
    id ? (packs.find((b) => b.id === id)?.serial ?? id.slice(0, 8)) : '—';
  const personName = (id: string) => {
    const u = people.find((x) => x.id === id);
    return u ? u.display_name || u.email : id.slice(0, 8);
  };

  const full = (events?.length ?? 0) >= DEFAULT_LEDGER_ROWS;

  return (
    <ScreenScaffold
      title="Ledger"
      sub={events ? `${events.length} change${events.length === 1 ? '' : 's'}${full ? ' (newest)' : ''}` : 'Loading'}
    >
      {error ? (
        <View style={[styles.notice, { backgroundColor: p.panelAlt }]}>
          <Text style={[T.rowLabel, { color: p.critical }]}>{error}</Text>
        </View>
      ) : null}

      <SectionLabel>Pack</SectionLabel>
      <Chips
        options={[{ key: '', label: 'Every pack' }, ...packs.map((b) => ({ key: b.id, label: b.serial }))]}
        selected={filter.batteryId ?? ''}
        onSelect={(key) => setFilter({ ...filter, batteryId: key || undefined })}
      />

      <SectionLabel>Source</SectionLabel>
      <Chips
        options={SOURCES.map((s) => ({ key: s ?? '', label: s ? SOURCE_LABEL[s] : 'Any' }))}
        selected={filter.source ?? ''}
        onSelect={(key) => setFilter({ ...filter, source: (key || undefined) as WriteSource | undefined })}
      />

      <SectionLabel>Outcome</SectionLabel>
      <Chips
        options={RESULTS.map((r) => ({ key: r ?? '', label: r ? RESULT_LABEL[r] : 'Any' }))}
        selected={filter.result ?? ''}
        onSelect={(key) => setFilter({ ...filter, result: (key || undefined) as WriteResult | undefined })}
      />

      {!events ? (
        error ? null : (
          <View style={styles.loading}>
            <ActivityIndicator color={p.accent} />
          </View>
        )
      ) : events.length === 0 ? (
        <Text style={[T.rowLabel, { color: p.inkSoft, marginTop: 16 }]}>
          Nothing recorded for this filter.
        </Text>
      ) : (
        <>
          <SectionLabel>Changes</SectionLabel>
          <View style={{ gap: 8 }}>
            {events.map((e) => (
              <View key={e.id} style={[styles.card, { backgroundColor: p.panelAlt }]}>
                <View style={styles.cardHead}>
                  <View style={{ flexShrink: 1 }}>
                    <Text style={[T.rowValue, { color: p.inkStrong }]}>
                      {e.parameterKey ?? 'Change'}
                    </Text>
                    <Text style={[T.caption, { color: p.inkSoft, marginTop: 2 }]}>
                      {describeChange(e)}
                    </Text>
                  </View>
                  <StatusChip tone={RESULT_TONE[e.result]} label={RESULT_LABEL[e.result]} />
                </View>
                <View style={styles.meta}>
                  <Text style={[T.caption, { color: p.inkFaint }]}>
                    {packSerial(e.batteryId)} · {personName(e.actorUserId)} · {SOURCE_LABEL[e.source]}
                  </Text>
                  <Text style={[T.caption, { color: p.inkFaint }]}>
                    {formatWhen(e.occurredAt)}
                    {wasUploadedLate(e) ? ` · uploaded ${formatWhen(e.recordedAt)}` : ''}
                  </Text>
                  {e.reason ? (
                    <Text style={[T.caption, { color: p.inkSoft, marginTop: 2 }]}>“{e.reason}”</Text>
                  ) : null}
                </View>
              </View>
            ))}
          </View>
          {full ? (
            <Text style={[T.caption, { color: p.inkFaint, marginTop: 10 }]}>
              Showing the newest {DEFAULT_LEDGER_ROWS}. Narrow the filter to see older changes.
            </Text>
          ) : null}
        </>
      )}
    </ScreenScaffold>
  );
}

/** A single-choice row of chips that scrolls sideways rather than wrapping. */
function Chips({
  options,
  selected,
  onSelect,
}: {
  options: { key: string; label: string }[];
  selected: string;
  onSelect: (key: string) => void;
}) {
  const { p } = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
      {options.map((o) => {
        const active = o.key === selected;
        return (
          <Pressable
            key={o.key || '_any'}
            onPress={() => onSelect(o.key)}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            style={[
              styles.chip,
              { backgroundColor: active ? p.accent : p.panelAlt, borderColor: active ? p.accent : p.panelStitch },
            ]}
          >
            <Text style={[T.tabLabel, { color: active ? p.panelBase : p.inkStrong }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  loading: { paddingVertical: 40, alignItems: 'center' },
  notice: { borderRadius: radii.card, padding: space.panel, marginTop: 8, marginBottom: 4 },
  chips: { flexDirection: 'row', gap: 8, paddingBottom: 4 },
  chip: { minHeight: 40, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1, justifyContent: 'center' },
  card: { borderRadius: radii.card, padding: 14, gap: 6 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  meta: { gap: 1 },
});
