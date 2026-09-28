import { PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { migrationsFolder } from "./migrate";
import * as schema from "./schema";

/**
 * Embedded PGlite database (ADR-002, ADR-020) — **development and tests only**. Never imported
 * statically by `client.ts` so production bundles do not carry the WASM engine.
 */
export interface PgliteHandle {
  db: PgliteDatabase<typeof schema>;
  close: () => Promise<void>;
}

/**
 * Open a PGlite database and apply the committed migrations. `dataDir` undefined = in-memory
 * (tests); a path = filesystem-backed (local dev, `PGLITE_DIR`, default `./.pglite`).
 */
export async function createPgliteDb(dataDir?: string): Promise<PgliteHandle> {
  const client = dataDir ? await PGlite.create({ dataDir }) : await PGlite.create();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: migrationsFolder() });
  return { db, close: () => client.close() };
}
