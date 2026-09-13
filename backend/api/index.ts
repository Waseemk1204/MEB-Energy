import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { openStore } from '../src/db/open.js';
import { secretFrom } from '../src/auth/tokens.js';
import { parseOrigins } from '../src/http/cors.js';
import { buildServer } from '../src/server.js';
import type { Dispatcher } from '../src/policy/writeService.js';

/**
 * The API as a Vercel function.
 *
 * One function answers every path (vercel.json rewrites them here), and
 * Fastify does the routing exactly as it does in the long-running process.
 * The server is built once per warm instance and kept in module scope, so a
 * cold start pays for the migration and the seed and the next few hundred
 * requests do not.
 *
 * The dispatcher is the same stub as main.ts: the device path does not exist
 * yet, and refusing honestly beats inventing a success.
 */
const notWiredYet: Dispatcher = {
  send: async () => {
    throw new Error('Command broker is not wired: no device path exists yet');
  },
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

let ready: Promise<FastifyInstance> | null = null;

async function build(): Promise<FastifyInstance> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required: a function has no disk for SQLite to live on');
  }
  const { store, seeded, bootstrap } = await openStore(process.env);
  // The one line that says whether anyone can sign in. The long-running
  // process logs it too; a deployment whose only window is the runtime log
  // needs it there.
  if (bootstrap.kind === 'created') {
    console.log(`Created ${bootstrap.companyName} and its first administrator: ${bootstrap.email}`);
  } else if (bootstrap.reason === 'not_configured') {
    const empty = await store.get<{ n: number }>('SELECT COUNT(*) AS n FROM users');
    if ((empty?.n ?? 0) === 0) {
      console.warn(
        'No users exist and BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD are not set: nobody can sign in.'
      );
    }
  }
  console.log(`Cold start: postgres, ${seeded} parameters`);
  const app = buildServer({
    store,
    secret: secretFrom(requiredEnv('JWT_SECRET')),
    dispatcher: notWiredYet,
    corsOrigins: parseOrigins(process.env.CORS_ORIGINS),
  });
  await app.ready();
  return app;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // A failed cold start must not poison every later request with the same
  // rejected promise: drop it so the next request tries again.
  ready ??= build().catch((error) => {
    ready = null;
    throw error;
  });
  const app = await ready;
  app.server.emit('request', req, res);
}
