import React from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ShieldCheck } from 'lucide-react-native';
import { useTheme } from '../../src/theme/ThemeProvider';
import { type as T } from '../../src/theme/type';
import { ScreenScaffold } from '../../src/ui/ScreenScaffold';
import { DataRow, FixedTag, RowGroup, SectionLabel } from '../../src/ui/primitives';
import {
  GROUP_ORDER,
  GROUP_TITLES,
  formatParameter,
  parametersIn,
  profile,
} from '../../src/bms/capabilityProfile';
import { useSettingsStore } from '../../src/store/useSettingsStore';
import { useSessionStore } from '../../src/store/useSessionStore';
import { useSecurityStore } from '../../src/store/useSecurityStore';
import { DEV_BYPASS_AUTH } from '../../src/config';
import { useInstallPrompt } from '../../src/pwa/install';
import { ROLE_LABEL } from '../../src/api/company';

/**
 * Configuration, kept separate from monitoring so a parameter can never be
 * changed by a stray tap on a screen someone was reading.
 *
 * Every row here is generated from the capability profile. Delete a parameter
 * from jbd-sp24s004.json and its row disappears with no code change — that is
 * what makes the vendor-neutral claim real rather than aspirational.
 */
export default function Settings() {
  const { p } = useTheme();
  const router = useRouter();
  const values = useSettingsStore((s) => s.values);
  const operator = useSessionStore((s) => s.operator);
  const company = useSessionStore((s) => s.company);
  const connectedBatteryId = useSessionStore((s) => s.connectedBatteryId);
  const signOut = useSessionStore((s) => s.signOut);
  const pinSet = useSecurityStore((s) => s.pinSet);
  const pinSetAt = useSecurityStore((s) => s.pinSetAt);
  const disconnect = useSessionStore((s) => s.disconnect);
  const role = useSessionStore((s) => s.role);
  const install = useInstallPrompt();

  return (
    <ScreenScaffold
      title="Settings"
      sub={`${profile.bmsModel} · capability profile`}
      back={false}
    >
      {GROUP_ORDER.map((group) => {
        const params = parametersIn(group);
        if (!params.length) return null;

        return (
          <View key={group}>
            <SectionLabel>{GROUP_TITLES[group]}</SectionLabel>
            <RowGroup>
              {params.map((param) => {
                const live = values[param.parameter_key] ?? param.value;
                return (
                  <DataRow
                    key={param.parameter_key}
                    label={param.display_name}
                    value={formatParameter(param, live)}
                    level={param.danger_level}
                    dimmed={!param.writable}
                    trailing={param.writable ? undefined : <FixedTag />}
                    onPress={
                      param.writable
                        ? () => router.push(`/write/${param.parameter_key}`)
                        : undefined
                    }
                  />
                );
              })}
            </RowGroup>
          </View>
        );
      })}

      <SectionLabel>Security</SectionLabel>
      <RowGroup tone="alt">
        <DataRow
          label="PIN for critical writes"
          value={pinSet ? 'On' : 'Off'}
          level={pinSet ? 'Normal' : 'Warning'}
          onPress={() => router.push('/pin')}
        />
        {pinSet && pinSetAt ? (
          <DataRow label="PIN set" value={new Date(pinSetAt).toLocaleDateString()} />
        ) : null}
      </RowGroup>
      <Text style={[T.caption, { color: p.inkFaint, marginTop: 10, marginHorizontal: 4 }]}>
        {pinSet
          ? 'Changes to Critical parameters ask for your PIN before they are sent to the BMS.'
          : 'No PIN is set. Critical parameters need only the acknowledgement and a reason.'}
      </Text>

      <SectionLabel>Session</SectionLabel>
      <RowGroup tone="alt">
        <DataRow label="Signed in as" value={operator ?? '—'} />
        <DataRow label="Role" value={ROLE_LABEL[role]} />
        <DataRow label="Company" value={company} />
        {role === 'company' ? (
          <DataRow label="Company settings" onPress={() => router.push('/company')} />
        ) : null}
        {install.kind === 'promptable' ? (
          <DataRow label="Install on this device" onPress={() => void install.install()} />
        ) : install.kind === 'manual' ? (
          <DataRow label="Install on this device" value={install.hint} />
        ) : null}
        <DataRow label="Connected battery" value={connectedBatteryId ?? 'none'} />
        <DataRow
          label="Switch battery"
          onPress={() => {
            disconnect();
            router.replace('/batteries');
          }}
        />
        <DataRow
          label="Sign out"
          level="Warning"
          onPress={() => signOut()}
        />
      </RowGroup>

      {DEV_BYPASS_AUTH && (
        <Text style={[T.caption, { color: p.warn, marginTop: 10, marginHorizontal: 4 }]}>
          Dev bypass is on: cold starts skip Login and link {connectedBatteryId} automatically. Sign
          out to walk the real flow, or set DEV_BYPASS_AUTH to false in src/config.ts.
        </Text>
      )}

      <View style={{ flexDirection: 'row', gap: 9, marginTop: 20, marginHorizontal: 4 }}>
        <ShieldCheck size={15} color={p.inkFaint} strokeWidth={2} style={{ marginTop: 2 }} />
        <Text style={[T.caption, { color: p.inkFaint, flex: 1 }]}>
          Values are the vendor datasheet defaults for this BMS. Over-current thresholds are fixed
          by the board&apos;s {profile.continuousCurrentA} A continuous rating and cannot be written.
          Editing any writable parameter opens the full safe-write confirmation.
        </Text>
      </View>
    </ScreenScaffold>
  );
}
