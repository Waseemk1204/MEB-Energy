import type { ApiClient } from '../api/client';
import { logWarn } from '../diagnostics/fieldLog';
import type { UploadBuffer, UploadSample } from './uploadBuffer';

/**
 * Sending buffered telemetry to the cloud.
 *
 * Frames are retired only on a confirmed response, and only by the count that
 * was actually sent — anything that arrived mid-flight stays queued. A failure
 * retires nothing and leaves the buffer to try again.
 */

/** One request's worth. The server accepts up to 2000. */
export const UPLOAD_CHUNK = 200;

export interface TelemetryFlush {
  sent: number;
  stored: number;
  keptForStateChange: number;
  error?: string;
}

/** Strip the client-only marker; the server decides state changes for itself. */
function toWire(sample: UploadSample) {
  const { stateChange: _ignored, ...wire } = sample;
  return wire;
}

export async function flushTelemetry(
  client: ApiClient,
  batteryId: string,
  buffer: UploadBuffer
): Promise<TelemetryFlush> {
  const batch = buffer.peek(UPLOAD_CHUNK);
  if (batch.length === 0) return { sent: 0, stored: 0, keptForStateChange: 0 };

  try {
    const response = await client.authedPost<{
      received: number;
      stored: number;
      keptForStateChange: number;
    }>(`/batteries/${encodeURIComponent(batteryId)}/telemetry`, {
      samples: batch.map(toWire),
    });

    // Retire exactly what was sent — not the buffer's current length, which
    // may already have grown while the request was in flight.
    buffer.retire(batch.length);

    return {
      sent: batch.length,
      stored: response.stored,
      keptForStateChange: response.keptForStateChange,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'telemetry upload failed';
    logWarn('app', 'Telemetry upload failed; frames stay buffered', { reason: message });
    return { sent: 0, stored: 0, keptForStateChange: 0, error: message };
  }
}
