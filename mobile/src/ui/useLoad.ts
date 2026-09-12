import { useEffect, useState } from 'react';

/**
 * Fetch something when a screen opens, and again on request.
 *
 * Nothing is set before the first await, and nothing is set after the screen
 * has gone: a reply arriving to an unmounted component would otherwise update
 * state nobody is showing. Errors are named rather than swallowed — somebody
 * staring at an empty list needs to know the difference between nothing and
 * a failed request.
 *
 * `reload` keeps the previous data on screen until the new data arrives, so a
 * refresh after a change does not blank the list it is refreshing.
 */
export function useLoad<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[],
  fallbackMessage: string
): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const next = await fetcher();
        if (!live) return;
        setData(next);
        setError(null);
      } catch (caught) {
        if (!live) return;
        setError(caught instanceof Error ? caught.message : fallbackMessage);
      }
    })();

    return () => {
      live = false;
    };
    // The fetcher is identified by its deps, the way an effect's would be.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  return { data, error, reload: () => setTick((t) => t + 1) };
}
