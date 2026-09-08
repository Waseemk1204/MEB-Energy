/**
 * Build-time switches.
 */

/**
 * Skip Login and the connect sequence on a cold start, landing straight on the
 * Dashboard with BAT-00042 already connected.
 *
 * This only seeds the *initial* session — the real flow stays fully walkable
 * at any time via Settings → Sign out, so the bypass never hides a broken
 * login path. Set to `false` to exercise the flow from a cold start instead.
 *
 * Always false in a release build.
 */
export const DEV_BYPASS_AUTH = __DEV__ && false;

/** The battery the dev bypass attaches to. */
export const DEV_BYPASS_BATTERY_ID = 'BAT-00042';

/**
 * Sign in without contacting the backend.
 *
 * This exists so the app is walkable before a server is running, and it is a
 * *build-time* switch on purpose: a runtime fallback that kicks in when the
 * network fails would mean cutting the network is a way past the login screen.
 *
 * Must be false in any build that leaves a developer's machine.
 */
export const OFFLINE_AUTH = __DEV__ && false;

/**
 * Seed the activity timeline with example entries.
 *
 * Purely so the timeline and the passive banner can be looked at before any
 * real writes exist. **Never true in a release build**, and the seeded entries
 * are marked as already accepted by the server so that even with it on, they
 * can never be uploaded.
 *
 * That second guard is the one that matters. The audit ledger is append-only —
 * there is a database trigger preventing updates and no delete path at all —
 * so a fabricated entry that reached it would be permanent. Before this flag
 * existed the seed was unconditional, and a fresh install would have pushed
 * three invented changes, one of them attributed to a person who does not
 * exist, into the ledger on its first connect.
 */
export const DEMO_ACTIVITY = __DEV__ && true;
