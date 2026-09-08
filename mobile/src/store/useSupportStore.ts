import { create } from 'zustand';
import { api } from '../api/session';
import {
  activeFor,
  listSupportSessions,
  type SupportSession,
} from '../api/supportSessions';

/**
 * Whether an administrator has a session open with the connected pack.
 *
 * Shared, because two screens show it and they must not disagree — the
 * Dashboard row said `SS-4471 active` while the Support screen showed a
 * different invention, and neither corresponded to anything.
 *
 * The three states are deliberately distinct. "Not checked yet", "checked and
 * there is none" and "could not check" are three different things to tell
 * somebody standing next to a battery, and collapsing them is how a network
 * failure comes to read as an all-clear.
 */
export type SupportState =
  | { kind: 'unchecked' }
  | { kind: 'none' }
  | { kind: 'unreachable' }
  | { kind: 'active'; session: SupportSession };

type Store = {
  state: SupportState;
  checking: boolean;
  refresh: (batteryId: string | null) => Promise<void>;
  reset: () => void;
};

export const useSupportStore = create<Store>((set, get) => ({
  state: { kind: 'unchecked' },
  checking: false,

  refresh: async (batteryId) => {
    if (get().checking) return;

    if (!batteryId) {
      // Nothing is linked, so nothing can be reached — that is a real answer
      // rather than an unknown.
      set({ state: { kind: 'none' } });
      return;
    }

    set({ checking: true });
    try {
      const sessions = await listSupportSessions(api);
      set({
        state:
          sessions === null
            ? { kind: 'unreachable' }
            : (() => {
                const session = activeFor(sessions, batteryId);
                return session ? { kind: 'active' as const, session } : { kind: 'none' as const };
              })(),
      });
    } finally {
      set({ checking: false });
    }
  },

  reset: () => set({ state: { kind: 'unchecked' }, checking: false }),
}));

/** One line for a row that has to fit on a dashboard. */
export function describeSupport(state: SupportState): string {
  switch (state.kind) {
    case 'active':
      return 'Session open';
    case 'none':
      // Not "None open": on a glanced-at row that shares a word with "Session
      // open", and these two must not be mistakable for one another.
      return 'None';
    case 'unreachable':
      return 'Could not check';
    case 'unchecked':
      return 'Checking…';
  }
}
