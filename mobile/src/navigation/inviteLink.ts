import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { INVITE_PATH } from '../brand';

/**
 * The link an invited person opens to set their first password.
 *
 * On the web it is a URL on the app's own origin, so it opens the installed
 * app or the site without a scheme the recipient's browser has never heard
 * of. On a phone it is the app's own scheme, which the router resolves to the
 * same screen. The token is the only part that matters.
 */
const FALLBACK_SCHEME = 'mebenergy';

function scheme(): string {
  const declared = Constants.expoConfig?.scheme;
  const first = Array.isArray(declared) ? declared[0] : declared;
  return first || FALLBACK_SCHEME;
}

export function inviteLink(token: string): string {
  const query = `?token=${encodeURIComponent(token)}`;
  if (Platform.OS === 'web') {
    const origin = (globalThis as { location?: { origin?: string } }).location?.origin ?? '';
    return `${origin}${INVITE_PATH}${query}`;
  }
  return `${scheme()}://${INVITE_PATH.replace(/^\//, '')}${query}`;
}

/** What goes into the share sheet or the clipboard. */
export function inviteMessage(companyName: string, token: string): string {
  const who = companyName.trim() || 'the team';
  return `You have been added to ${who}. Set your password here: ${inviteLink(token)}`;
}

/**
 * Whether a share sheet exists. The web has one only on some browsers; when
 * there is none the link is copied instead, and the screen says so.
 */
export function canShare(): boolean {
  if (Platform.OS !== 'web') return true;
  const nav = (globalThis as { navigator?: { share?: unknown } }).navigator;
  return typeof nav?.share === 'function';
}
