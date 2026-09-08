import type { BatterySnapshot } from './types';

/**
 * Deciding which telemetry frames are worth uploading.
 *
 * The app samples at 2 Hz — 172,800 frames per battery per day — and a chart
 * cannot show a hundredth of that. So frames are thinned to one per
 * {@link SAMPLE_INTERVAL_MS} before they ever leave the phone.
 *
 * With one exception, and it is the whole reason this is not a timer:
 * **a frame whose fault state differs from the last kept one is always kept.**
 * Thinning away the moment a cell over-voltage first appeared erases the only
 * frame that mattered, leaving a history that looks calm on both sides of an
 * event nobody can now find. The backend applies the same rule on ingest, but
 * it can only preserve what reaches it — a frame discarded here is gone for
 * good, so this is the copy of the rule that actually protects the event.
 *
 * The buffer is bounded, and the bound is enforced the same way: ordinary
 * frames are dropped first, and a frame recording a change in fault state is
 * only dropped once nothing else is left.
 *
 * **It refuses simulated frames outright.** These readings go to a server and
 * are then shown to people as measurements from a physical pack — a fabricated
 * state of charge in a fleet list reads exactly like a real one. `USE_MOCK`
 * being off is not enough on its own: a flag can be flipped by mistake, and
 * nothing downstream of here could tell the difference afterwards.
 */

/** One frame per ten seconds, matching the server's own ingest interval. */
export const SAMPLE_INTERVAL_MS = 10_000;

/** Roughly three hours of thinned samples before back-pressure applies. */
export const MAX_BUFFERED = 1_000;

export interface UploadSample {
  recordedAt: number;
  soc: number;
  packVoltage: number;
  packCurrent: number;
  temperatureC: number;
  minCellV: number;
  maxCellV: number;
  deltaMv: number;
  faultCount: number;
  balancing: boolean;
  /** True when this frame was kept because the fault state changed. */
  stateChange: boolean;
}

export function toSample(snapshot: BatterySnapshot, stateChange = false): UploadSample {
  return {
    recordedAt: snapshot.timestamp,
    soc: snapshot.soc,
    packVoltage: snapshot.packVoltage,
    packCurrent: snapshot.packCurrent,
    // The wire carries one temperature; the highest probe is the one that
    // matters for a thermal event, so a mean would hide exactly the case
    // this is recorded for.
    temperatureC: snapshot.temperatures.length ? Math.max(...snapshot.temperatures) : 0,
    minCellV: snapshot.minCellV,
    maxCellV: snapshot.maxCellV,
    deltaMv: snapshot.deltaMv,
    faultCount: snapshot.faults.length,
    balancing: snapshot.balancing,
    stateChange,
  };
}

export class UploadBuffer {
  private samples: UploadSample[] = [];
  private lastKept: UploadSample | null = null;
  private droppedCount = 0;
  private refusedCount = 0;

  /**
   * Frames turned away because they were not real. Counted rather than
   * ignored: a buffer that is silently empty during a mock session should be
   * distinguishable from one that is empty because nothing happened.
   */
  get refused(): number {
    return this.refusedCount;
  }

  /**
   * Offer a frame. Returns true when it was kept.
   *
   * A frame is kept when the interval has elapsed, or when its fault count
   * differs from the last kept frame's — whichever comes first.
   */
  offer(snapshot: BatterySnapshot, simulated = false): boolean {
    // Never buffered, never counted against the interval, never uploaded.
    // Nothing downstream of this point could tell an invented reading from a
    // measured one, so this is the only place it can be refused.
    if (simulated) {
      this.refusedCount += 1;
      return false;
    }

    const faultCount = snapshot.faults.length;
    const changedState = this.lastKept !== null && faultCount !== this.lastKept.faultCount;
    const dueBySchedule =
      this.lastKept === null || snapshot.timestamp - this.lastKept.recordedAt >= SAMPLE_INTERVAL_MS;

    if (!dueBySchedule && !changedState) return false;

    const sample = toSample(snapshot, changedState && !dueBySchedule);
    this.samples.push(sample);
    this.lastKept = sample;
    this.enforceCap();
    return true;
  }

  /**
   * Ordinary frames go first. A frame recording a change in fault state is only
   * discarded when there is nothing else left to discard — it is the one frame
   * whose absence would misrepresent what happened.
   */
  private enforceCap(): void {
    if (this.samples.length <= MAX_BUFFERED) return;

    const ordinary = this.samples.findIndex((s) => !s.stateChange);
    const index = ordinary === -1 ? 0 : ordinary;
    this.samples.splice(index, 1);
    this.droppedCount += 1;
  }

  /** What would be sent next, oldest first. Does not remove anything. */
  peek(limit = this.samples.length): UploadSample[] {
    return this.samples.slice(0, limit);
  }

  /**
   * Remove frames the server has confirmed, by count from the front.
   *
   * Taken as a count rather than by identity because the server acknowledges a
   * batch, and frames arriving while an upload is in flight must stay queued
   * rather than being retired by a response that never saw them.
   *
   * `lastKept` is deliberately untouched: emptying the queue does not reset
   * what was last *sent*, and a fault clearing immediately after a flush must
   * still register as a change.
   */
  retire(count: number): void {
    if (count <= 0) return;
    this.samples.splice(0, Math.min(count, this.samples.length));
  }

  get size(): number {
    return this.samples.length;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  /** A link to a different pack must not inherit this one's history. */
  reset(): void {
    this.samples = [];
    this.lastKept = null;
    this.droppedCount = 0;
  }
}
