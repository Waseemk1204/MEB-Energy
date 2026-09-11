import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useTheme } from '../../src/theme/ThemeProvider';
import { radii, space } from '../../src/theme/tokens';
import { type as T } from '../../src/theme/type';
import { ScreenScaffold } from '../../src/ui/ScreenScaffold';
import { PrimaryButton, SectionLabel, StatusChip } from '../../src/ui/primitives';
import { api } from '../../src/api/session';
import {
  addPack,
  editPack,
  listFleet,
  reinstatePack,
  retirePack,
  type FleetPack,
} from '../../src/api/admin';
import { profile } from '../../src/bms/capabilityProfile';
import { useSessionStore } from '../../src/store/useSessionStore';
import { logWarn } from '../../src/diagnostics/fieldLog';

/**
 * A company's fleet, for looking after rather than connecting to.
 *
 * The technician's battery list is for picking a pack to open. This one is for
 * adding a pack, correcting its serial, and taking it out of service — and it
 * shows retired packs, which the technician's list deliberately does not.
 *
 * Retiring is not deleting. The audit ledger names packs by id, and a ledger
 * entry pointing at nothing is a ledger with a hole in it.
 */
export default function Fleet() {
  const { p } = useTheme();
  const companyId = useSessionStore((s) => s.companyId);

  const [fleet, setFleet] = useState<FleetPack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<FleetPack | null>(null);
  const [serial, setSerial] = useState('');
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const rows = await listFleet(api);
        if (!live) return;
        setFleet(rows);
        setError(null);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'Could not load your fleet';
        logWarn('ui', 'Fleet failed', { message });
        if (live) setError(message);
      }
    })();
    return () => {
      live = false;
    };
  }, [reloadKey]);

  const reload = () => setReloadKey((k) => k + 1);

  const onAdd = async () => {
    const trimmed = serial.trim();
    if (!companyId || !trimmed) return;
    setBusy(true);
    setError(null);
    try {
      // The supported pack is the one profile the app knows. Chemistry and
      // cell count follow from it; a second BMS is a second profile, not a
      // form field here.
      await addPack(api, {
        companyId,
        serial: trimmed,
        chemistry: profile.chemistry,
        cellCount: profile.cellCount,
        bmsManufacturer: profile.vendor,
        bmsModel: profile.bmsModel,
      });
      setSerial('');
      setAdding(false);
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not add that pack');
    } finally {
      setBusy(false);
    }
  };

  const onSaveEdit = async () => {
    const trimmed = serial.trim();
    if (!editing || !trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await editPack(api, editing.id, { serial: trimmed });
      setEditing(null);
      setSerial('');
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save that');
    } finally {
      setBusy(false);
    }
  };

  const onRetire = (pack: FleetPack) => {
    Alert.alert(
      `Retire ${pack.serial}?`,
      'It leaves the technicians’ list and anyone connected to it is disconnected. Its history is kept, and it can be brought back.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Retire',
          style: 'destructive',
          onPress: () => {
            void retirePack(api, pack.id)
              .then(reload)
              .catch((caught: unknown) =>
                setError(caught instanceof Error ? caught.message : 'Could not retire it')
              );
          },
        },
      ]
    );
  };

  const onReinstate = (pack: FleetPack) => {
    void reinstatePack(api, pack.id)
      .then(reload)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Could not bring it back')
      );
  };

  const inService = fleet?.filter((b) => b.status === 'active') ?? [];
  const retired = fleet?.filter((b) => b.status === 'retired') ?? [];

  const startEdit = (pack: FleetPack) => {
    setAdding(false);
    setEditing(pack);
    setSerial(pack.serial);
  };

  const form = (title: string, action: string, onSubmit: () => void) => (
    <View style={[styles.form, { backgroundColor: p.panelAlt }]}>
      <Text style={[T.sectionLabel, { color: p.inkFaint }]}>{title}</Text>
      <TextInput
        value={serial}
        onChangeText={setSerial}
        placeholder="MEB-24S-0114"
        placeholderTextColor={p.inkFaint}
        accessibilityLabel="Serial number"
        autoCapitalize="characters"
        autoCorrect={false}
        style={[styles.input, { backgroundColor: p.panelBase, color: p.inkStrong, borderColor: p.panelStitch }]}
      />
      <Text style={[T.caption, { color: p.inkSoft }]}>
        {profile.cellCount}S {profile.chemistry} · {profile.bmsModel}
      </Text>
      <PrimaryButton label={busy ? 'Saving…' : action} onPress={onSubmit} disabled={!serial.trim() || busy} />
    </View>
  );

  return (
    <ScreenScaffold
      title="Fleet"
      sub={fleet ? `${inService.length} in service` : 'Loading'}
      right={
        <Pressable
          onPress={() => {
            setEditing(null);
            setSerial('');
            setAdding((v) => !v);
          }}
          accessibilityRole="button"
          accessibilityLabel={adding ? 'Cancel adding a pack' : 'Add a pack'}
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

      {adding ? form('New pack serial', 'Add pack', () => void onAdd()) : null}
      {editing ? form(`Editing ${editing.serial}`, 'Save', () => void onSaveEdit()) : null}

      {!fleet ? (
        error ? null : (
          <View style={styles.loading}>
            <ActivityIndicator color={p.accent} />
          </View>
        )
      ) : fleet.length === 0 ? (
        <Text style={[T.rowLabel, { color: p.inkSoft, marginTop: 16 }]}>
          No packs yet. Add your first one.
        </Text>
      ) : (
        <>
          {inService.length > 0 ? (
            <>
              <SectionLabel>In service</SectionLabel>
              <View style={{ gap: 10 }}>
                {inService.map((b) => (
                  <PackCard
                    key={b.id}
                    pack={b}
                    actions={[
                      { label: 'Edit', tone: 'accent', onPress: () => startEdit(b) },
                      { label: 'Retire', tone: 'critical', onPress: () => onRetire(b) },
                    ]}
                  />
                ))}
              </View>
            </>
          ) : null}

          {retired.length > 0 ? (
            <>
              <SectionLabel>Retired</SectionLabel>
              <View style={{ gap: 10 }}>
                {retired.map((b) => (
                  <PackCard
                    key={b.id}
                    pack={b}
                    dimmed
                    actions={[{ label: 'Bring back', tone: 'accent', onPress: () => onReinstate(b) }]}
                  />
                ))}
              </View>
            </>
          ) : null}
        </>
      )}
    </ScreenScaffold>
  );
}

function PackCard({
  pack,
  actions,
  dimmed,
}: {
  pack: FleetPack;
  actions: { label: string; tone: 'accent' | 'critical'; onPress: () => void }[];
  dimmed?: boolean;
}) {
  const { p } = useTheme();
  const soc = pack.lastReading ? `${Math.round(pack.lastReading.soc)}%` : null;

  return (
    <View style={[styles.card, { backgroundColor: p.panelAlt }, dimmed && { opacity: 0.7 }]}>
      <View style={styles.cardHead}>
        <View style={{ flexShrink: 1 }}>
          <Text style={[T.rowValue, { color: p.inkStrong }]}>{pack.serial}</Text>
          <Text style={[T.caption, { color: p.inkSoft, marginTop: 2 }]}>
            {pack.cell_count}S {pack.chemistry}
            {pack.bms_model ? ` · ${pack.bms_model}` : ''}
          </Text>
        </View>
        {/* A retired card sits under a "Retired" heading and is dimmed; a
            chip saying it again is noise, and a stale SOC would mislead. */}
        {pack.status === 'retired' ? null : soc ? (
          <Text style={[T.rowValue, { color: p.inkStrong }]}>{soc}</Text>
        ) : (
          <StatusChip tone="neutral" label="No reading" />
        )}
      </View>
      <View style={[styles.actions, { borderTopColor: p.panelStitch }]}>
        {actions.map((a) => (
          <Pressable
            key={a.label}
            onPress={a.onPress}
            accessibilityRole="button"
            accessibilityLabel={`${a.label} ${pack.serial}`}
            style={styles.action}
          >
            <Text style={[T.tabLabel, { color: a.tone === 'critical' ? p.critical : p.accent }]}>
              {a.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
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
