import { config as loadDotenv } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import { seedCatalog, type SeedReport } from "../src/db/seed";

/**
 * `npm run db:seed` — idempotent upsert of the reference data (exercise catalog, aliases,
 * benchmark WODs, strength templates).
 *
 *  - `DIRECT_DATABASE_URL` set → Postgres (Supabase direct connection).
 *  - Otherwise, outside production → the local PGlite database (`PGLITE_DIR`, default
 *    `./.pglite`), migrated first. Stop the dev server before seeding: PGlite is single-process.
 */
async function seedPostgres(url: string): Promise<SeedReport> {
  const client = postgres(url, { max: 1, prepare: false });
  try {
    return await seedCatalog(drizzle(client, { schema }));
  } finally {
    await client.end();
  }
}

async function seedPglite(dataDir: string): Promise<SeedReport> {
  const { createPgliteDb } = await import("../src/db/pglite");
  const { db, close } = await createPgliteDb(dataDir);
  try {
    return await seedCatalog(db);
  } finally {
    await close();
  }
}

async function main(): Promise<void> {
  loadDotenv({ path: [".env.local", ".env"], quiet: true });
  const url = process.env.DIRECT_DATABASE_URL;
  const production = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
  if (!url && production) throw new Error("Missing DIRECT_DATABASE_URL");
  const report = url
    ? await seedPostgres(url)
    : await seedPglite(process.env.PGLITE_DIR ?? "./.pglite");
  process.stdout.write(
    `Seeded ${report.exercises} exercises, ${report.aliases} aliases, ${report.benchmarks} benchmarks, ${report.templates} templates.\n`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
