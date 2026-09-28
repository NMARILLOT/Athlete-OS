import type { Db } from "./client";
import { createPgliteDb } from "./pglite";

/**
 * In-memory PGlite database with the committed migrations applied — for Vitest integration
 * tests (ARCHITECTURE.md §2 "Tests", ADR-002). Each call is an isolated database.
 */
export interface TestDb {
  db: Db;
  close: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const { db, close } = await createPgliteDb();
  return { db, close };
}
