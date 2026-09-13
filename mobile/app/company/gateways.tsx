import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { useTheme } from '../../src/theme/ThemeProvider';
import { radii, space } from '../../src/theme/tokens';
import { type as T } from '../../src/theme/type';
import { ScreenScaffold } from '../../src/ui/ScreenScaffold';
import { PrimaryButton, SectionLabel, StatusChip } from '../../src/ui/primitives';
import { confirmDestructive } from '../../src/ui/confirm';
import { api } from '../../src/api/session';
import {
  SECURITY_LABEL,
  SECURITY_MEANING,
  SECURITY_TONE,
  listGateways,
  registerGateway,
  rotateGatewayKey,
  setGatewaySecurity,
  type Gateway,
  type GatewaySecurity,
  type RegisteredGateway,
} from '../../src/api/gateways';
import { listFleet } from '../../src/api/company';
import { useLoad } from '../../src/ui/useLoad';

/**
 * The company's gateways (PRD §8.1).
 *
 * The app refuses to authenticate a gateway that is not in service, so the
 * status here is the lever that takes a suspect one out of use. Quarantine is
 * reversible while something is checked; revocation is meant to be final, and
 * is not offered as a routine action to undo.
 */
export default function Gateways() {
  const { p } = useTheme();

  const { data, error: loadError, reload } = useLoad(
    async () => {
      const [gateways, packs] = await Promise.all([listGateways(api), listFleet(api)]);
      return { gateways, packs };
    },
    [],
    'Could not load gateways'
  );
  const gateways = data?.gateways ?? null;
  const packs = data?.packs ?? [];
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * The provisioning line, shown once. The key in it is never shown again
   * by the dashboard; whoever is holding the gateway pastes it into the
   * gateway's console now, or rotates the key later and gets a new one.
   */
  const [provisioning, setProvisioning] = useState<{ serial: string; line: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [serial, setSerial] = useState('');
  const [hardware, setHardware] = useState('');
  const [firmware, setFirmware] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const canSubmit = serial.trim().length > 0 && hardware.trim().length > 0 && firmware.trim().length > 0;

  const onRegister = async () => {
    if (!canSubmit) return;
    setBusy('new');
    setError(null);
    try {
      const registered = await registerGateway(api, {
        serial: serial.trim(),
        hardwareRevision: hardware.trim(),
        firmwareVersion: firmware.trim(),
      });
      await showProvisioning(serial.trim(), registered);
      setSerial('');
      setHardware('');
      setFirmware('');
      setAdding(false);
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not register that gateway');
    } finally {
      setBusy(null);
    }
  };

  const showProvisioning = async (gatewaySerial: string, registered: RegisteredGateway) => {
    setProvisioning({ serial: gatewaySerial, line: registered.provisioning });
    await Clipboard.setStringAsync(registered.provisioning).catch(() => undefined);
  };

  /**
   * A new key: after a phone that held the old one is lost, or for a
   * gateway registered before keys existed. Until the gateway is provisioned
   * again with the new line, the app refuses it — which is the point.
   */
  const onRotate = (gateway: Gateway) =>
    confirmDestructive(
      `New key for ${gateway.serial}?`,
      'Every app will refuse this gateway until the new provisioning line is typed into its console. The old key stops working now.',
      'Rotate key',
      () => {
        void rotateGatewayKey(api, gateway.id)
          .then((r) => showProvisioning(gateway.serial, r))
          .then(reload)
          .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Could not rotate the key'));
      }
    );

  const change = async (gateway: Gateway, next: GatewaySecurity) => {
    setBusy(gateway.id);
    setError(null);
    setNotice(null);
    try {
      await setGatewaySecurity(api, gateway.id, next);
      setNotice(`${gateway.serial}: ${SECURITY_MEANING[next]}`);
      reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not change that gateway');
    } finally {
      setBusy(null);
    }
  };

  /** Revocation is permanent in practice, so it asks and names the gateway. */
  const onRevoke = (gateway: Gateway) =>
    confirmDestructive(
      `Revoke ${gateway.serial}?`,
      'The app will refuse this gateway from now on. For one that is lost or compromised. Use quarantine instead if it is only being checked.',
      'Revoke',
      () => void change(gateway, 'revoked')
    );

  const packSerial = (id: string | null) =>
    id ? (packs.find((b) => b.id === id)?.serial ?? 'Unknown pack') : 'Unassigned';

  return (
    <ScreenScaffold
      title="Gateways"
      sub={gateways ? `${gateways.length} registered` : 'Loading'}
      right={
        <Pressable
          onPress={() => setAdding((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={adding ? 'Cancel registering a gateway' : 'Register a gateway'}
          hitSlop={10}
          style={styles.add}
        >
          <Text style={[T.tabLabel, { color: p.leatherInk }]}>{adding ? 'Cancel' : 'Add'}</Text>
        </Pressable>
      }
    >
      {error || loadError ? (
        <View style={[styles.notice, { backgroundColor: p.panelAlt }]}>
          <Text style={[T.rowLabel, { color: p.critical }]}>{error ?? loadError}</Text>
        </View>
      ) : null}
      {notice ? (
        <View style={[styles.notice, { backgroundColor: p.panelAlt }]} accessibilityRole="alert">
          <Text style={[T.rowLabel, { color: p.inkStrong }]}>{notice}</Text>
        </View>
      ) : null}

      {provisioning ? (
        <View style={[styles.notice, { backgroundColor: p.panelAlt, borderLeftWidth: 3, borderLeftColor: p.accent }]} accessibilityRole="alert">
          <Text style={[T.rowValue, { color: p.inkStrong }]}>Provision {provisioning.serial} now</Text>
          <Text style={[T.caption, { color: p.inkSoft, marginTop: 4 }]}>
            Copied to the clipboard. Paste this line into the gateway’s serial console (115200 baud).
            It is shown once; a lost line means rotating the key.
          </Text>
          <Text selectable style={[T.caption, styles.mono, { color: p.inkStrong }]} accessibilityLabel="Provisioning line">
            {provisioning.line}
          </Text>
          <Pressable onPress={() => setProvisioning(null)} accessibilityRole="button" style={styles.action}>
            <Text style={[T.tabLabel, { color: p.accent }]}>Done</Text>
          </Pressable>
        </View>
      ) : null}

      {adding ? (
        <View style={[styles.form, { backgroundColor: p.panelAlt }]}>
          <Text style={[T.sectionLabel, { color: p.inkFaint }]}>Serial</Text>
          <TextInput
            value={serial}
            onChangeText={setSerial}
            placeholder="GW-000184"
            placeholderTextColor={p.inkFaint}
            accessibilityLabel="Gateway serial"
            autoCapitalize="characters"
            style={[styles.input, { backgroundColor: p.panelBase, color: p.inkStrong, borderColor: p.panelStitch }]}
          />
          <Text style={[T.sectionLabel, { color: p.inkFaint }]}>Hardware revision</Text>
          <TextInput
            value={hardware}
            onChangeText={setHardware}
            placeholder="HW 1.0"
            placeholderTextColor={p.inkFaint}
            accessibilityLabel="Hardware revision"
            style={[styles.input, { backgroundColor: p.panelBase, color: p.inkStrong, borderColor: p.panelStitch }]}
          />
          <Text style={[T.sectionLabel, { color: p.inkFaint }]}>Firmware</Text>
          <TextInput
            value={firmware}
            onChangeText={setFirmware}
            placeholder="FW 1.2.4"
            placeholderTextColor={p.inkFaint}
            accessibilityLabel="Firmware version"
            style={[styles.input, { backgroundColor: p.panelBase, color: p.inkStrong, borderColor: p.panelStitch }]}
          />
          <PrimaryButton
            label={busy === 'new' ? 'Registering…' : 'Register gateway'}
            onPress={() => void onRegister()}
            disabled={!canSubmit || busy !== null}
          />
          <Text style={[T.caption, { color: p.inkSoft }]}>
            Registered in service. The serial must be the one printed on the gateway.
          </Text>
        </View>
      ) : null}

      {!gateways ? (
        loadError ? null : (
          <View style={styles.loading}>
            <ActivityIndicator color={p.accent} />
          </View>
        )
      ) : gateways.length === 0 ? (
        <Text style={[T.rowLabel, { color: p.inkSoft, marginTop: 16 }]}>
          No gateways registered yet.
        </Text>
      ) : (
        <>
          <SectionLabel>Registered</SectionLabel>
          <View style={{ gap: 10 }}>
            {gateways.map((g) => (
              <View key={g.id} style={[styles.card, { backgroundColor: p.panelAlt }]}>
                <View style={styles.cardHead}>
                  <View style={{ flexShrink: 1 }}>
                    <Text style={[T.rowValue, { color: p.inkStrong }]}>{g.serial}</Text>
                    <Text style={[T.caption, { color: p.inkSoft, marginTop: 2 }]}>
                      {g.hardware_revision} · {g.firmware_version} · {packSerial(g.assigned_battery_id)}
                    </Text>
                    {!g.auth_key ? (
                      <Text style={[T.caption, { color: p.warn, marginTop: 2 }]}>
                        No key: registered before keys existed. Rotate to provision it.
                      </Text>
                    ) : null}
                  </View>
                  <StatusChip tone={SECURITY_TONE[g.security_status]} label={SECURITY_LABEL[g.security_status]} />
                </View>

                <View style={[styles.actions, { borderTopColor: p.panelStitch }]}>
                  {g.security_status === 'valid' ? (
                    <>
                      <Action label="Rotate key" tone={p.inkSoft} disabled={busy === g.id} onPress={() => onRotate(g)} />
                      <Action label="Quarantine" tone={p.warn} disabled={busy === g.id} onPress={() => void change(g, 'quarantined')} />
                      <Action label="Revoke" tone={p.critical} disabled={busy === g.id} onPress={() => onRevoke(g)} />
                    </>
                  ) : g.security_status === 'quarantined' ? (
                    <>
                      <Action label="Return to service" tone={p.accent} disabled={busy === g.id} onPress={() => void change(g, 'valid')} />
                      <Action label="Revoke" tone={p.critical} disabled={busy === g.id} onPress={() => onRevoke(g)} />
                    </>
                  ) : (
                    // Revocation is meant to be final. Reversing it is still
                    // possible, but it is not offered as a routine action.
                    <View style={styles.action}>
                      <Text style={[T.tabLabel, { color: p.inkFaint }]}>Permanently out of service</Text>
                    </View>
                  )}
                </View>
              </View>
            ))}
          </View>
          <Text style={[T.caption, { color: p.inkFaint, marginTop: 10 }]}>
            Quarantine is reversible — use it while a gateway is being checked. Revocation is
            for one that is lost or compromised.
          </Text>
        </>
      )}
    </ScreenScaffold>
  );
}

function Action({
  label,
  tone,
  disabled,
  onPress,
}: {
  label: string;
  tone: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" style={styles.action}>
      <Text style={[T.tabLabel, { color: tone, opacity: disabled ? 0.5 : 1 }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  loading: { paddingVertical: 40, alignItems: 'center' },
  notice: { borderRadius: radii.card, padding: space.panel, marginTop: 8, marginBottom: 4 },
  add: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  form: { borderRadius: radii.card, padding: space.panel, gap: 8, marginTop: 8, marginBottom: 8 },
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
  mono: { fontFamily: 'Courier', marginTop: 8 },
  action: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
