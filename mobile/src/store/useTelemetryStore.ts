import { create } from 'zustand';
import { MockSource } from '../telemetry/MockSource';
import { BleSource } from '../telemetry/BleSource';
import type { BatterySnapshot, TelemetrySource } from '../telemetry/types';
import type { GatewayClient } from '../ble/gateway';
import { UploadBuffer } from '../telemetry/uploadBuffer';
import { flushTelemetry } from '../telemetry/uploader';
import { api } from '../api/session';

/**
 * Simulated pack, or a real gateway over Bluetooth.
 *
 * Simulated unless the build says otherwise: `EXPO_PUBLIC_TELEMETRY=ble` at
 * build (or `expo start`) time turns the real path on. No screen file changes
 * either way — that is the whole point of the TelemetrySource seam. The
 * simulator says it is simulated, and the upload buffer refuses its frames,
 * so a mock session can never put an invented reading in the ledger.
 */
export const USE_MOCK = process.env.EXPO_PUBLIC_TELEMETRY !== 'ble';

export interface HistoryPoint {
  t: number;
  soc: number;
  packVoltage: number;
  packCurrent: number;
  temp: number;
}

const HISTORY_LIMIT = 240; // 2 minutes at 2 Hz

/**
 * How often buffered telemetry is pushed to the cloud.
 *
 * Not every frame and not every kept sample: a request per ten seconds would
 * drain a phone that spends its day linked to a pack. Frames accumulate in the
 * buffer and go up in batches, and nothing is lost if a flush fails.
 */
export const FLUSH_INTERVAL_MS = 60_000;

type TelemetryState = {
  snapshot: BatterySnapshot | null;
  history: HistoryPoint[];
  source: TelemetrySource | null;
  /** Thinned frames waiting to reach the cloud. */
  buffer: UploadBuffer;
  /** Set while a batch is in flight, so two flushes cannot overlap. */
  flushing: boolean;
  /** The pack these frames belong to; uploads are addressed to it. */
  batteryId: string | null;
  flushTimer: ReturnType<typeof setInterval> | null;
  /**
   * With a gateway: frames come off it. Without one: the simulator. The
   * session store decides which, because it is the one that ran the
   * connect sequence and knows whether a verified gateway exists.
   */
  connect: (batteryId: string, gateway?: GatewayClient | null) => void;
  disconnect: () => void;
  flush: () => Promise<void>;
};

export const useTelemetryStore = create<TelemetryState>((set, get) => ({
  snapshot: null,
  history: [],
  source: null,
  buffer: new UploadBuffer(),
  flushing: false,
  batteryId: null,
  flushTimer: null,

  connect: (batteryId, gateway = null) => {
    if (get().source) return;

    // A new link must not inherit the previous pack's frames.
    get().buffer.reset();
    const source: TelemetrySource = gateway ? new BleSource(gateway) : new MockSource();
    source.start((snapshot) => {
      set((state) => {
        const point: HistoryPoint = {
          t: snapshot.timestamp,
          soc: snapshot.soc,
          packVoltage: snapshot.packVoltage,
          packCurrent: snapshot.packCurrent,
          temp: snapshot.temperatures[0] ?? 0,
        };
        const history = [...state.history, point];
        if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);

        // Thinning happens here rather than at upload time: a frame discarded
        // by the buffer is gone, so the fault-state rule has to run on every
        // frame, not on whatever a timer happened to catch.
        //
        // The source says whether it is real. A mock session still drives every
        // gauge and every screen; it simply never reaches the server, because
        // an invented reading is indistinguishable from a measured one once it
        // is a row in a table.
        state.buffer.offer(snapshot, source.simulated);
        return { snapshot, history };
      });
    });

    const timer = setInterval(() => {
      void get().flush();
    }, FLUSH_INTERVAL_MS);

    set({ source, flushTimer: timer, batteryId });
  },

  flush: async () => {
    const { buffer, flushing, batteryId } = get();
    if (flushing || !batteryId || buffer.size === 0) return;

    set({ flushing: true });
    await flushTelemetry(api, batteryId, buffer);
    set({ flushing: false });
  },

  disconnect: () => {
    get().source?.stop();

    const { flushTimer } = get();
    if (flushTimer) clearInterval(flushTimer);

    // One last attempt before the link goes: these frames are already thinned,
    // and losing them to a clean disconnect would be careless. The battery id
    // is cleared only after, so the flush still knows where to send them.
    void get()
      .flush()
      .finally(() => set({ batteryId: null }));

    set({ source: null, flushTimer: null });
  },
}));
