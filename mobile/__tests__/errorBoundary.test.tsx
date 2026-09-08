import React from 'react';
import { Text } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';

import { ErrorBoundary } from '../src/ui/ErrorBoundary';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { clearLog, getLog } from '../src/diagnostics/fieldLog';
import { addSink } from '../src/diagnostics/reporter';

const wrap = (ui: React.ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>);

function Boom({ fail }: { fail: boolean }): React.ReactElement {
  if (fail) throw new Error('gauge exploded');
  return <Text>working screen</Text>;
}

/** React logs caught errors to console.error; that noise is expected here. */
let consoleError: jest.SpyInstance;
beforeEach(() => {
  clearLog();
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => consoleError.mockRestore());

describe('when a screen renders fine', () => {
  it('stays out of the way', async () => {
    const q = await wrap(
      <ErrorBoundary scope="dashboard">
        <Boom fail={false} />
      </ErrorBoundary>
    );
    expect(q.getByText('working screen')).toBeTruthy();
  });
});

describe('when a screen throws', () => {
  const boom = () => (
    <ErrorBoundary scope="dashboard">
      <Boom fail />
    </ErrorBoundary>
  );

  it('shows a recovery screen instead of a blank one', async () => {
    const q = await wrap(boom());
    expect(q.getByText('This screen stopped working')).toBeTruthy();
  });

  /** A technician at a live pack needs to know the link and the pack are fine. */
  it('reassures that nothing was written and the link is intact', async () => {
    const q = await wrap(boom());
    expect(q.getByText(/connection to the battery is still open/)).toBeTruthy();
    expect(q.getByText(/Nothing was written/)).toBeTruthy();
  });

  it('names the scope and the error, so a report is actionable', async () => {
    const q = await wrap(boom());
    expect(q.getByText(/dashboard — gauge exploded/)).toBeTruthy();
  });

  it('offers a way back', async () => {
    const q = await wrap(boom());
    expect(q.getByLabelText('Try again')).toBeTruthy();
  });

  it('points at the diagnostic log for a repeat failure', async () => {
    const q = await wrap(boom());
    expect(q.getByText(/export the diagnostic log from Help/)).toBeTruthy();
  });
});

describe('reporting', () => {
  it('records the failure in the field log', async () => {
    await wrap(
      <ErrorBoundary scope="cells">
        <Boom fail />
      </ErrorBoundary>
    );
    const entry = getLog().find((e) => e.message.includes('gauge exploded'));
    expect(entry).toBeDefined();
    expect(entry?.level).toBe('error');
    expect(entry?.message).toMatch(/^cells: /);
  });

  it('hands the error to a registered crash sink', async () => {
    const sink = jest.fn();
    const remove = addSink(sink);
    await wrap(
      <ErrorBoundary scope="history">
        <Boom fail />
      </ErrorBoundary>
    );
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'gauge exploded' }),
      expect.objectContaining({ scope: 'history' })
    );
    remove();
  });

  /** A broken crash reporter must not become the user's problem. */
  it('survives a sink that throws', async () => {
    const remove = addSink(() => {
      throw new Error('sentry is down');
    });
    const q = await wrap(
      <ErrorBoundary scope="settings">
        <Boom fail />
      </ErrorBoundary>
    );
    expect(q.getByText('This screen stopped working')).toBeTruthy();
    remove();
  });
});

describe('recovery', () => {
  it('remounts the subtree when the cause has gone', async () => {
    // The failure condition lives outside the component: one that throws during
    // render never mounts, so it could never clear the flag itself.
    let shouldFail = true;
    function Flaky() {
      if (shouldFail) throw new Error('transient');
      return <Text>recovered</Text>;
    }

    const q = await wrap(
      <ErrorBoundary scope="dashboard">
        <Flaky />
      </ErrorBoundary>
    );
    expect(q.getByText('This screen stopped working')).toBeTruthy();

    shouldFail = false;
    await fireEvent.press(q.getByLabelText('Try again'));
    expect(q.getByText('recovered')).toBeTruthy();
  });

  it('shows the failure again if the cause persists', async () => {
    const q = await wrap(
      <ErrorBoundary scope="dashboard">
        <Boom fail />
      </ErrorBoundary>
    );
    await fireEvent.press(q.getByLabelText('Try again'));
    expect(q.getByText('This screen stopped working')).toBeTruthy();
  });
});
