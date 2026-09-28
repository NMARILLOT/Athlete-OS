import { config as loadDotenv } from "dotenv";
import { runMigrations } from "../src/db/migrate";

/**
 * `npm run db:migrate` — apply the committed migrations under ./drizzle against
 * DIRECT_DATABASE_URL (ADR-020). Fails loudly when the URL is missing.
 */
async function main(): Promise<void> {
  loadDotenv({ path: [".env.local", ".env"], quiet: true });
  await runMigrations();
  process.stdout.write("Migrations applied.\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
