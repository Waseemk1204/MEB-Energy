import Constants from 'expo-constants';

/**
 * Whose app this is.
 *
 * The name comes from `app.json` (`expo.name`) so that rebranding is a config
 * change, not a code change: the manifest, the home-screen icon label and every
 * screen that says the company's name all read the same value. The signed-in
 * header shows the company's own name from the server, which an administrator
 * can rename; this is what the app calls itself before anyone has signed in.
 */
export const APP_NAME: string = Constants.expoConfig?.name?.trim() || 'MEB Energy';

/** The line under the name on the sign-in screen. */
export const APP_TAGLINE = 'Battery diagnostics & configuration';

/**
 * The URL scheme and web path an invitation link uses. The scheme is the one
 * in `app.json`; on the web the link is a plain URL on the app's own origin.
 */
export const INVITE_PATH = '/accept-invite';
