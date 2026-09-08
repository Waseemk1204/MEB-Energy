import { create } from 'zustand';
import { api } from '../api/session';
import { claimCommands, reportResult } from '../api/commands';
import { HEARTBEAT_INTERVAL_MS, announcePresence, endPresence } from '../api/presence';
import { executeWrite } from '../telemetry/writeOutcome';
import { useTelemetryStore } from './useTelemetryStore';
import { useProfileStore } from './useProfileStore';
import { useSettingsStore } from './useSettingsStore';
import { useActivityStore } from './useActivityStore';
import { logInfo, logWarn } from '../diagnostics/fieldLog';
import { formatParameter } from '../bms/capabilityProfile';

/**
 * Applying changes an administrator issued (PRD §6.3, Mode 1).
 *
 * The technician is not asked. A remote change arrives, is applied to the BMS
 * over the same write path a local change uses, and they are told afterwards
 * by the passive banner and the activity timeline. That is the design, not an
 * oversight — and this store is the thing that makes it actually happen rather
 * than leaving an administrator's change queued forever.
 *
 * Commands are applied **one at a time, in the order the server handed them
 * over**. Two protection thresholds written concurrently to one BMS over one
 * BLE link is not something the hardware or the audit trail would thank anyone
 * for.
 *
 * Each pass also refreshes the app's cloud presence, and it does so **first**.
 * The server hands nothing over to a caller it does not believe is standing at
 * the pack, so presence is not bookkeeping alongside the claim — it is the
 * precondition for it. Announcing after claiming would mean the first pass of
 * every link came back empty.
 */

type RemoteState = {
  /** Set while a claimed command is being applied. */
  applying: boolean;
  /** Whether the cloud currently believes this technician is at the pack. */
  present: boolean;
  /** How many remote changes this link has applied. */
  appliedCount: number;
  timer: ReturnType<typeof setInterval> | null;
  /** The pack this poller is bound to, so it can end its presence cleanly. */
  batteryId: string | null;

  start: (batteryId: string) => void;
  stop: () => void;
  /** One poll-and-apply pass. Exposed so a link can force one immediately. */
  poll: (batteryId: string) => Promise<void>;
};

export const useRemoteChangeStore = create<RemoteState>((set, get) => ({
  applying: false,
  present: false,
  appliedCount: 0,
  timer: null,
  batteryId: null,

  start: (batteryId) => {
    if (get().timer) return;

    // One immediately, so a change issued while the technician was walking up
    // does not wait a full interval.
    void get().poll(batteryId);

    const timer = setInterval(() => void get().poll(batteryId), HEARTBEAT_INTERVAL_MS);
    set({ timer, batteryId });
  },

  stop: () => {
    const { timer, batteryId } = get();
    if (timer) clearInterval(timer);

    // Ended deliberately rather than left to time out. Thirty seconds in which
    // an administrator believes somebody is standing at a pack they have
    // walked away from is thirty seconds in which a change can be issued as
    // deliverable and then wait indefinitely.
    if (batteryId) void endPresence(api, batteryId);

    set({ timer: null, applying: false, present: false, batteryId: null });
  },

  poll: async (batteryId) => {
    // Never overlap: a second pass could claim more work while the first is
    // still driving the BLE link. The flag is raised *before* the claim, not
    // after it — set afterwards, two passes both get past the guard and both
    // claim, which is the one thing it exists to prevent.
    if (get().applying) return;
    set({ applying: true });

    try {
      // Presence first, and every pass. The server refuses to hand anything to
      // a caller whose session it does not hold, and a session goes stale
      // without a heartbeat — so this is what makes the claim below possible
      // rather than something done beside it.
      const presence = await announcePresence(api, batteryId);
      set({ present: presence !== null });

      const commands = await claimCommands(api, batteryId);

      for (const command of commands) {
        const parameter = useProfileStore.getState().parameterFor(command.parameterKey);
        const source = useTelemetryStore.getState().source;

        if (!parameter) {
          // The server knows a parameter this build does not. Reporting it
          // rejected is the honest answer and releases the command; silently
          // dropping it would leave it claimed forever.
          logWarn('write', 'Remote change names an unknown parameter', {
            parameterKey: command.parameterKey,
          });
          await reportResult(api, command.id, 'rejected', 'app:unknown_parameter');
          continue;
        }

        const before = useSettingsStore.getState().currentValue(parameter);
        const classified = await executeWrite(
          source,
          command.parameterKey,
          command.value,
          parameter.precision
        );

        // Report before anything else: the command is claimed server-side, and
        // an unreported one never completes.
        await reportResult(api, command.id, classified.outcome, classified.message ?? undefined);

        // Only a confirmed read-back may change what the app claims is on the
        // BMS — the same rule a local write follows.
        if (classified.confirmedValue !== null) {
          useSettingsStore.getState().setValue(command.parameterKey, classified.confirmedValue);
        }

        // This is how the technician finds out. There is no prompt, so the
        // banner and the timeline are the only notice they get.
        useActivityStore.getState().add({
          parameterKey: parameter.parameter_key,
          displayName: parameter.display_name,
          oldValue: formatParameter(parameter, before),
          newValue: formatParameter(
            parameter,
            classified.confirmedValue !== null ? classified.confirmedValue : command.value
          ),
          actor: 'Administrator',
          source: command.forcePush ? 'admin_force_push' : 'admin_remote',
          dangerLevel: parameter.danger_level,
          result: classified.outcome,
          supportSessionId: command.supportSessionId,
        });

        set({ appliedCount: get().appliedCount + 1 });
        logInfo('write', 'Applied a remote change', {
          parameterKey: command.parameterKey,
          outcome: classified.outcome,
        });
      }
    } finally {
      set({ applying: false });
    }
  },
}));
