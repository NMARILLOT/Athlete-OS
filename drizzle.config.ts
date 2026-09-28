import { config as loadDotenv } from "dotenv";
import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit configuration (ADR-002, ADR-020, ARCHITECTURE.md §2).
 *
 * Migrations, push, pull and studio talk to Postgres through the direct (session-mode)
 * connection `DIRECT_DATABASE_URL`, never through the transaction pooler. `generate` only
 * reads the schema and needs no database, so the URL is only required for the commands that
 * connect.
 */
loadDotenv({ path: [".env.local", ".env"], quiet: true });

const COMMANDS_NEEDING_DATABASE = new Set(["migrate", "push", "pull", "introspect", "studio"]);
const needsDatabase = process.argv.some((arg) => COMMANDS_NEEDING_DATABASE.has(arg));
const url = process.env.DIRECT_DATABASE_URL;

if (needsDatabase && !url) {
  throw new Error(
    "DIRECT_DATABASE_URL is required for drizzle-kit migrate/push/pull/studio (see .env.example).",
  );
}

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  ...(url ? { dbCredentials: { url } } : {}),
  strict: true,
  verbose: true,
});
