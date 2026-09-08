import React from 'react';
import { Text } from 'react-native';
import { useTheme } from '../src/theme/ThemeProvider';
import { type as T } from '../src/theme/type';
import { ScreenScaffold } from '../src/ui/ScreenScaffold';
import { DataRow, RowGroup, SectionLabel, StatusChip } from '../src/ui/primitives';
import { useTelemetryStore } from '../src/store/useTelemetryStore';
import { useSessionStore } from '../src/store/useSessionStore';
import { useFreshness } from '../src/telemetry/freshness';

/**
 * Gateway identity. Security Status is green only when device authentication
 * passed — the app refuses to treat an unverified peripheral as a knowyourEV
 * device, and says so here rather than failing silently.
 *
 * The gateway reports its own serial, hardware revision and firmware over BLE,
 * and that path does not exist yet. This screen used to fill those rows with
 * plausible-looking values — `KYE-000184`, `HW 1.0`, `FW 1.2.4` — which a
 * technician would reasonably have read as the device in their hand. It now
 * says it does not know, which is the truth and is more useful than a
 * convincing invention.
 */
export default function Device() {
  const { p } = useTheme();
  const snapshot = useTelemetryStore((s) => s.snapshot);
  const batteryId = useSessionStore((s) => s.connectedBatteryId);
  const authenticated = snapshot?.bleState === 'connected';

  /**
   * Ticks on its own interval rather than reading the clock during render.
   * A render-time `Date.now()` is impure — the age would be whatever it was
   * when React last happened to re-render, which for a screen nobody is
   * touching is "when you opened it", frozen.
   */
  const freshness = useFreshness(snapshot?.timestamp);

  /** Said once, the same way, everywhere it applies. */
  const unknown = 'Not reported yet';

  return (
    <ScreenScaffold title="Device" sub="knowyourEV gateway">
      <SectionLabel>Identity</SectionLabel>
      <RowGroup tone="alt">
        <DataRow label="Device ID" value={unknown} />
        <DataRow label="Hardware revision" value={unknown} />
        <DataRow label="Firmware" value={unknown} />
        <DataRow label="Assigned battery" value={batteryId ?? 'Not connected'} />
      </RowGroup>

      <Text style={[T.caption, { color: p.inkFaint, marginTop: -6, marginBottom: 4 }]}>
        A gateway reports its own identity over Bluetooth. Until that link exists these are
        genuinely unknown, and showing a plausible value here would be worse than showing none.
      </Text>

      <SectionLabel>Connection</SectionLabel>
      <RowGroup tone="alt">
        <DataRow
          label="BLE state"
          trailing={
            <StatusChip
              tone={authenticated ? 'good' : 'warn'}
              label={snapshot?.bleState ?? 'disconnected'}
            />
          }
        />
        <DataRow
          label="Last seen"
          value={snapshot ? `${freshness.ageLabel} ago` : unknown}
        />
        <DataRow
          label="Security status"
          level={authenticated ? 'Normal' : 'Critical'}
          trailing={
            <StatusChip
              tone={authenticated ? 'good' : 'critical'}
              label={authenticated ? 'Valid' : 'Unverified'}
            />
          }
        />
      </RowGroup>

      <Text style={[T.caption, { color: p.inkFaint, marginTop: 16, marginHorizontal: 4 }]}>
        {authenticated
          ? 'This peripheral passed device authentication. Telemetry and commands are only exchanged with a verified knowyourEV gateway.'
          : 'This peripheral has not passed device authentication. Reads and writes are blocked until it does.'}
      </Text>
    </ScreenScaffold>
  );
}
