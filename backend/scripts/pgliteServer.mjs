#!/usr/bin/env node
/**
 * A Postgres on localhost with nothing to install.
 *
 *   node scripts/pgliteServer.mjs            # postgres://postgres:postgres@localhost:5432/postgres
 *   PGLITE_PORT=5433 node scripts/pgliteServer.mjs
 *
 * PGlite behind the Postgres wire protocol, so the API can be run and
 * live-checked through the real `pg` driver -- the pool, the type parsers,
 * the placeholder rewrite -- without a Postgres install or a Neon branch.
 * Data lives in memory and is gone when this exits.
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = Number(process.env.PGLITE_PORT ?? 5432);
const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
await server.start();
console.log(`PGlite listening on postgres://postgres:postgres@localhost:${port}/postgres`);

const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
