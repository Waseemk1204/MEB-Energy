import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { ThemeProvider } from '../theme/ThemeProvider';
import { useSessionStore } from '../store/useSessionStore';
import { SignedOutBanner } from './SignedOutBanner';

jest.mock('../diagnostics/fieldLog', () => ({ logWarn: jest.fn(), logInfo: jest.fn() }));

/**
 * The company account is capped at a number of devices, and a sign-in past the
 * cap signs out the one used longest ago. Evicting rather than refusing is
 * only defensible if the person is told — this is the telling.
 */

const show = async (signedOut: string[]) => {
  useSessionStore.setState({ signedOut });
  return render(
    <ThemeProvider>
      <SignedOutBanner />
    </ThemeProvider>
  );
};

afterEach(() => useSessionStore.setState({ signedOut: [] }));

it('says nothing when nothing was signed out', async () => {
  await show([]);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('names the device that was signed out', async () => {
  await show(['Safari on iPhone, last used 3h ago']);
  expect(screen.getByText(/Safari on iPhone, last used 3h ago/)).toBeTruthy();
});

/**
 * The reason this is worth showing at all: somebody who did not sign in
 * anywhere new has just learned that somebody else did.
 */
it('tells them what to do if it was not them', async () => {
  await show(['Safari on iPhone, last used 3h ago']);
  expect(screen.getByText(/change its password/i)).toBeTruthy();
});

it('summarises rather than listing when several went at once', async () => {
  await show(['Chrome on Mac, last used 2h ago', 'Safari on iPhone, last used 1 day ago']);
  expect(screen.getByText(/signed out 2 other devices/i)).toBeTruthy();
});

it('still names them all when several went', async () => {
  await show(['Chrome on Mac, last used 2h ago', 'Safari on iPhone, last used 1 day ago']);
  expect(screen.getByText(/Chrome on Mac.*Safari on iPhone/)).toBeTruthy();
});

/** It reports something that already happened, so it does not have to stay. */
it('can be dismissed', async () => {
  await show(['Safari on iPhone, last used 3h ago']);
  fireEvent.press(screen.getByLabelText('Dismiss'));
  expect(useSessionStore.getState().signedOut).toEqual([]);
});

it('reaches a screen reader as an alert', async () => {
  await show(['Safari on iPhone, last used 3h ago']);
  expect(screen.getByRole('alert')).toBeTruthy();
});
