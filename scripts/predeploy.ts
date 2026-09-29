import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { runMigrations } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { seedCatalog } from "../src/db/seed";
import { parseServerEnv } from "../src/server/env-schema";

/**
 * Vercel build hook — `npm run vercel-build`, which Vercel runs instead of `build` (ADR-024).
 *
 * On a PRODUCTION deployment, before `next build`:
 *  1. validates the runtime environment with the app's own rules (`parseServerEnv`), so a missing or
 *     wrong variable fails the build with a readable list instead of a 500 after deploy;
 *  2. applies the committed migrations (`./drizzle`) on DIRECT_DATABASE_URL;
 *  3. upserts the reference data (exercise catalog, aliases, benchmarks, templates).
 * Steps 2–3 are idempotent, so every production deploy can run them.
 *
 * Preview / development deployments and local builds skip everything: an unmerged migration must
 * never reach the production database. Locally, use `npm run db:migrate` and `npm run db:seed`.
 */

const CONNECTION_HINT = [
  "",
  "Pistes :",
  "  • DIRECT_DATABASE_URL doit être l'URL « Session pooler » de Supabase (hôte *.pooler.supabase.com, port 5432).",
  "    La « Direct connection » (db.<ref>.supabase.co) n'est joignable qu'en IPv6, pas depuis Vercel.",
  "  • Remplace [YOUR-PASSWORD] par le mot de passe de la base ; s'il contient des caractères spéciaux,",
  "    encode-les dans l'URL ou choisis un mot de passe fait uniquement de lettres et de chiffres.",
  "  • Si le projet Supabase est en pause (offre gratuite), relance-le depuis le tableau de bord.",
].join("\n");

/** Drizzle wraps driver errors ("Failed query: …"); the useful part is the innermost cause. */
function rootCause(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth++) {
    const next =
      current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined;
    if (!next) break;
    current = next;
  }
  if (!(current instanceof Error)) return String(current);
  const code = (current as Error & { code?: string }).code;
  return code ? `${current.message} (${code})` : current.message;
}

function log(line: string): void {
  process.stdout.write(`[predeploy] ${line}\n`);
}

async function seed(url: string): Promise<string> {
  const client = postgres(url, { max: 1, prepare: false, connect_timeout: 15, onnotice: () => {} });
  try {
    const r = await seedCatalog(drizzle(client, { schema }));
    return `${r.exercises} exercices, ${r.aliases} alias, ${r.benchmarks} benchmarks, ${r.templates} modèles`;
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const target = process.env.VERCEL_ENV;
  if (target !== "production") {
    log(
      target
        ? `déploiement ${target} : migrations et seed ignorés (réservés à la production).`
        : "hors Vercel : rien à faire (utilise npm run db:migrate / db:seed en local).",
    );
    return;
  }

  // 1. Same rules as the running app (fails closed: DATABASE_URL, Supabase, ALLOWED_EMAILS…).
  try {
    parseServerEnv(process.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Variables d'environnement de production invalides.\n${message
        .replace(/^Invalid server environment — /, "")
        .split("; ")
        .map((issue) => `  • ${issue}`)
        .join("\n")}\nCorrige-les dans Vercel (Settings → Environment Variables), puis redéploie.`,
    );
  }
  if (!process.env.CRON_SECRET)
    log("attention : CRON_SECRET absent, le recalcul quotidien (/api/cron/daily) sera refusé.");

  const direct = process.env.DIRECT_DATABASE_URL;
  if (!direct)
    throw new Error(
      "DIRECT_DATABASE_URL manquant : il sert à appliquer les migrations avant chaque déploiement." +
        CONNECTION_HINT,
    );

  // 2–3. Migrations then reference data.
  try {
    await runMigrations(direct);
    log("migrations appliquées.");
    log(`données de référence à jour : ${await seed(direct)}.`);
  } catch (error) {
    throw new Error(
      `Base de données injoignable ou refusée : ${rootCause(error)}${CONNECTION_HINT}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(
    `\n[predeploy] ÉCHEC — ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
