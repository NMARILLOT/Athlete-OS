import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * SQL migrations (ADR-002, ADR-020). The committed files under `./drizzle` are applied against
 * the direct (session-mode) connection before every deploy; the app never migrates at runtime
 * in production.
 */

/** Absolute path of the committed drizzle-kit migrations folder. */
export function migrationsFolder(): string {
  return path.resolve(process.cwd(), "drizzle");
}

/**
 * Apply pending migrations against `DIRECT_DATABASE_URL` (postgres.js, one connection,
 * no prepared statements). Throws when the URL is missing.
 */
export async function runMigrations(
  directUrl: string | undefined = process.env.DIRECT_DATABASE_URL,
): Promise<void> {
  if (!directUrl) {
    throw new Error("Missing DIRECT_DATABASE_URL: migrations need the direct Postgres connection.");
  }
  const client = postgres(directUrl, { max: 1, prepare: false });
  try {
    await migrate(drizzle(client), { migrationsFolder: migrationsFolder() });
  } finally {
    await client.end();
  }
}
