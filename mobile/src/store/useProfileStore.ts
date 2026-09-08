import { create } from 'zustand';
import { profile, type BmsParameter } from '../bms/capabilityProfile';
import { api } from '../api/session';
import { describeDrift, fetchDefinitions, reconcile, type Drift } from '../api/parameters';
import { logInfo, logWarn } from '../diagnostics/fieldLog';

/**
 * The parameter set the app actually enforces against.
 *
 * It starts as the bundled profile so Settings renders with no network — a
 * technician in a basement still needs the screen. Once the server has been
 * reached, the server's bounds replace the bundled ones, because PRD §5.2 puts
 * the boundary there and not here.
 *
 * `source` says which of the two is in force, so a screen can be honest about
 * whether it is showing verified limits or a shipped default.
 */
type ProfileState = {
  parameters: BmsParameter[];
  source: 'bundled' | 'server';
  syncedAt: number | null;
  drift: Drift[];
  syncing: boolean;

  sync: (bmsModel?: string) => Promise<void>;
  parameterFor: (key: string) => BmsParameter | undefined;
  reset: () => void;
};

const BUNDLED = profile.parameters;

export const useProfileStore = create<ProfileState>((set, get) => ({
  parameters: BUNDLED,
  source: 'bundled',
  syncedAt: null,
  drift: [],
  syncing: false,

  sync: async (bmsModel = profile.bmsModel) => {
    if (get().syncing) return;
    set({ syncing: true });
    try {
      const server = await fetchDefinitions(api, bmsModel);
      const { parameters, drift } = reconcile(profile, server);

      // A disagreement between the shipped file and the server is a defect in
      // this build, not a runtime condition. It is logged loudly and kept for
      // the diagnostics screen rather than being quietly resolved.
      if (drift.length > 0) {
        for (const line of describeDrift(drift)) {
          logWarn('profile', 'Capability profile drift', { detail: line });
        }
      } else {
        logInfo('profile', 'Capability profile matches the server');
      }

      set({ parameters, source: 'server', syncedAt: Date.now(), drift, syncing: false });
    } catch (error) {
      // Staying on the bundled profile is the correct fallback: it is what the
      // app has always rendered, and every write is checked server-side anyway.
      logWarn('profile', 'Could not reach the server profile; using the bundled one', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      set({ syncing: false });
    }
  },

  parameterFor: (key) => get().parameters.find((p) => p.parameter_key === key),

  reset: () => set({ parameters: BUNDLED, source: 'bundled', syncedAt: null, drift: [] }),
}));
