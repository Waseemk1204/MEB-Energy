import { Platform } from 'react-native';
import { inviteLink, inviteMessage } from './inviteLink';

/**
 * The link has to open the app wherever the recipient is: a scheme URL on a
 * phone, a plain URL on the app's own origin in a browser.
 */
describe('the invitation link', () => {
  const os = Platform.OS;
  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  });

  it('is a scheme URL on a phone', () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    expect(inviteLink('tok-1')).toBe('mebenergy://accept-invite?token=tok-1');
  });

  it('is a URL on the app’s own origin in a browser', () => {
    Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true });
    const g = globalThis as { location?: unknown };
    const before = g.location;
    Object.defineProperty(globalThis, 'location', { value: { origin: 'https://app.example' }, configurable: true });
    expect(inviteLink('tok-1')).toBe('https://app.example/accept-invite?token=tok-1');
    Object.defineProperty(globalThis, 'location', { value: before, configurable: true });
  });

  it('escapes the token', () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    expect(inviteLink('a b&c')).toContain('token=a%20b%26c');
  });

  it('names the company in the message', () => {
    expect(inviteMessage('Acme EV', 't')).toMatch(/added to Acme EV/);
  });

  it('does not invent a company name', () => {
    expect(inviteMessage('  ', 't')).toMatch(/added to the team/);
  });
});
