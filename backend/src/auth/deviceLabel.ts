/**
 * A readable name for whatever is signing in.
 *
 * From the User-Agent, which is neither reliable nor unique — two identical
 * phones look the same. It is here so that a session can be called "Safari on
 * iPhone" instead of "somewhere", not as an identifier anything depends on.
 */
export function labelFor(userAgent: string | undefined): string | null {
  if (!userAgent) return null;

  const platform =
    /iPhone/i.test(userAgent) ? 'iPhone'
    : /iPad/i.test(userAgent) ? 'iPad'
    : /Android/i.test(userAgent) ? 'Android'
    : /Macintosh|Mac OS/i.test(userAgent) ? 'Mac'
    : /Windows/i.test(userAgent) ? 'Windows'
    : /Linux/i.test(userAgent) ? 'Linux'
    : null;

  const browser =
    /Edg\//i.test(userAgent) ? 'Edge'
    : /OPR\//i.test(userAgent) ? 'Opera'
    : /Chrome\//i.test(userAgent) ? 'Chrome'
    : /Firefox\//i.test(userAgent) ? 'Firefox'
    : /Safari\//i.test(userAgent) ? 'Safari'
    : /Expo|okhttp|CFNetwork/i.test(userAgent) ? 'the app'
    : null;

  if (browser && platform) return `${browser} on ${platform}`;
  return browser ?? platform ?? userAgent.slice(0, 40);
}
