import { logError, type LogEntry } from './fieldLog';

/**
 * Where crashes and handled errors go.
 *
 * Today this only writes to the field log. It exists as its own seam so that
 * wiring a crash service — `@sentry/react-native` is the intended one — is a
 * change to this file and nothing else. The plan's Phase 01 lists that as a
 * separate step because it needs a DSN and an account, neither of which should
 * hold up the error handling itself.
 *
 * Whatever service lands here inherits the field log's redaction rules: no
 * tokens, no PINs, no credentials, ever.
 */

export interface ErrorContext {
  /** Where it happened — a screen name, or the operation in flight. */
  scope: string;
  /** Small, non-sensitive facts that make a report diagnosable. */
  detail?: LogEntry['detail'];
}

type Sink = (error: Error, context: ErrorContext) => void;

const sinks: Sink[] = [];

/** Registered by a crash service at boot. */
export function addSink(sink: Sink): () => void {
  sinks.push(sink);
  return () => {
    const i = sinks.indexOf(sink);
    if (i >= 0) sinks.splice(i, 1);
  };
}

export function reportError(error: unknown, context: ErrorContext): void {
  const err = error instanceof Error ? error : new Error(String(error));

  logError('app', `${context.scope}: ${err.message}`, context.detail);

  for (const sink of sinks) {
    try {
      sink(err, context);
    } catch {
      // A reporting failure must never become the user's problem.
    }
  }
}
