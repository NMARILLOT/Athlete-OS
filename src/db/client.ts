import "server-only";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Database client (ARCHITECTURE.md §2/§7, ADR-002, ADR-020).
 *
 *  - `DATABASE_URL` set → postgres.js through the Supabase transaction pooler
 *    (`prepare: false`, one connection per serverless instance), cached on `globalThis`.
 *  - No URL in production / on Vercel → boot fails ("Missing DATABASE_URL").
 *  - No URL locally → embedded PGlite under `PGLITE_DIR` (default `./.pglite`) with the committed
 *    migrations applied on first creation. Never used in production.
 */

export type DbSchema = typeof schema;

/** Driver-agnostic database handle: postgres.js in production, PGlite in dev/tests. */
export type Db = PgDatabase<PgQueryResultHKT, DbSchema>;

declare global {
  // `var` is required to augment `globalThis`.
  var __athleteosDb: Promise<Db> | undefined;
}

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
}

function createPostgresDb(url: string): Db {
  const client = postgres(url, { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 10 });
  return drizzle(client, { schema });
}

/** Create a fresh database handle according to the environment. Prefer `getDb()`. */
export async function createDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) return createPostgresDb(url);
  if (isProductionRuntime()) throw new Error("Missing DATABASE_URL");
  const { createPgliteDb } = await import("./pglite");
  const handle = await createPgliteDb(process.env.PGLITE_DIR ?? "./.pglite");
  return handle.db;
}

/** Process-wide singleton (survives Next.js dev HMR). */
export function getDb(): Promise<Db> {
  if (!globalThis.__athleteosDb) {
    globalThis.__athleteosDb = createDb().catch((error: unknown) => {
      globalThis.__athleteosDb = undefined;
      throw error;
    });
  }
  return globalThis.__athleteosDb;
}
