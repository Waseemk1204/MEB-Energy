import { MockSource } from './MockSource';
import { BleSource } from './BleSource';
import { useTelemetryStore, USE_MOCK } from '../store/useTelemetryStore';

jest.mock('../api/session', () => ({ api: {} }));
jest.mock('../diagnostics/fieldLog', () => ({ logInfo: jest.fn(), logWarn: jest.fn() }));

/**
 * Where a reading came from, and whether the upload path is told.
 *
 * The guard in `UploadBuffer` was written and tested first, and the wiring
 * between the store and the buffer was not — so a mutation removing the second
 * argument passed the whole suite. The guard is only worth having if it is
 * actually reached.
 */

describe('a source declares whether it is real', () => {
  it('the mock says it is not', () => {
    expect(new MockSource().simulated).toBe(true);
  });

  it('the BLE source says it is', () => {
    expect(new BleSource('KYE-000184').simulated).toBe(false);
  });

  /** Two sources that both claimed the same thing would make the flag useless. */
  it('they disagree, which is the point', () => {
    expect(new MockSource().simulated).not.toBe(new BleSource('x').simulated);
  });
});

describe('a live session', () => {
  afterEach(() => {
    useTelemetryStore.getState().disconnect();
  });

  /**
   * The end-to-end property. A mock session drives every gauge and every
   * screen — it simply never reaches the server, because an invented reading
   * is indistinguishable from a measured one once it is a row in a table.
   */
  it('buffers nothing while the source is simulated', async () => {
    if (!USE_MOCK) return; // Nothing to prove once BleSource is wired.

    useTelemetryStore.getState().connect('BAT-00042');
    await new Promise((r) => setTimeout(r, 1400));

    const { buffer, snapshot } = useTelemetryStore.getState();
    expect(snapshot).not.toBeNull(); // the screens still get their data
    expect(buffer.size).toBe(0); // and none of it is queued for the server
    expect(buffer.refused).toBeGreaterThan(0); // refused, not merely absent
  });

  it('still feeds the on-screen history', async () => {
    if (!USE_MOCK) return;

    useTelemetryStore.getState().connect('BAT-00042');
    await new Promise((r) => setTimeout(r, 1400));

    expect(useTelemetryStore.getState().history.length).toBeGreaterThan(0);
  });
});
