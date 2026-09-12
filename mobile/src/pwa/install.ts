import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

/**
 * "Add to home screen", offered from inside the app.
 *
 * Chromium browsers fire `beforeinstallprompt` when the page qualifies as an
 * installable web app; holding on to that event lets the app show its own
 * Install row and open the browser's prompt from it. Safari has no such
 * event — there the row explains the Share → Add to Home Screen route
 * instead, which is the only honest thing to say.
 *
 * Nothing here runs natively: an installed app has nothing to install.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallState =
  | { kind: 'unavailable' }
  | { kind: 'installed' }
  | { kind: 'promptable'; install: () => Promise<boolean> }
  | { kind: 'manual'; hint: string };

const IOS_HINT = 'In Safari: Share, then “Add to Home Screen”.';

function isStandalone(): boolean {
  const w = globalThis as {
    matchMedia?: (q: string) => { matches: boolean };
    navigator?: { standalone?: boolean };
  };
  return (
    w.matchMedia?.('(display-mode: standalone)').matches === true ||
    w.navigator?.standalone === true
  );
}

function isIos(): boolean {
  const ua = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? '';
  return /iPhone|iPad|iPod/i.test(ua);
}

export function useInstallPrompt(): InstallState {
  const [state, setState] = useState<InstallState>(() => {
    if (Platform.OS !== 'web') return { kind: 'unavailable' };
    if (isStandalone()) return { kind: 'installed' };
    if (isIos()) return { kind: 'manual', hint: IOS_HINT };
    return { kind: 'unavailable' };
  });

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const target = globalThis as unknown as EventTarget | undefined;
    if (!target?.addEventListener) return;

    const onPrompt = (event: Event) => {
      event.preventDefault();
      const deferred = event as BeforeInstallPromptEvent;
      setState({
        kind: 'promptable',
        install: async () => {
          await deferred.prompt();
          const { outcome } = await deferred.userChoice;
          if (outcome === 'accepted') setState({ kind: 'installed' });
          return outcome === 'accepted';
        },
      });
    };
    const onInstalled = () => setState({ kind: 'installed' });

    target.addEventListener('beforeinstallprompt', onPrompt);
    target.addEventListener('appinstalled', onInstalled);
    return () => {
      target.removeEventListener('beforeinstallprompt', onPrompt);
      target.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  return state;
}
