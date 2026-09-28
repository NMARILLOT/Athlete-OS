import "server-only";
import { eq } from "drizzle-orm";
import { cache } from "react";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { allowedEmails, env } from "@/server/env";
import { ForbiddenError, UnauthorizedError } from "@/server/errors";
import { log } from "@/server/logging";
import { supabaseServerClient } from "./supabase";
import { LOCAL_USER_ID, type CurrentUser } from "./types";

/**
 * Resolve the current user (ADR-021):
 *  - local mode: the single fixed local user, upserted lazily;
 *  - supabase mode: the session user from the request cookies, checked against ALLOWED_EMAILS,
 *    with the `users` row upserted lazily by auth uid (no auth trigger needed).
 * Cached per request (React cache) so layouts, pages and actions share one lookup.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const e = env();
  if (e.AUTH_MODE === "local") {
    return upsertUser({
      id: LOCAL_USER_ID,
      email: e.LOCAL_USER_EMAIL,
      timezone: e.LOCAL_USER_TIMEZONE,
    });
  }
  const supabase = await supabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !user.email) return null;
  const allow = allowedEmails();
  if (allow.length && !allow.includes(user.email.toLowerCase())) {
    log.warn("auth.email_not_allowed", { userId: user.id });
    throw new ForbiddenError("Ce compte n'est pas autorisé.");
  }
  return upsertUser({ id: user.id, email: user.email, timezone: e.LOCAL_USER_TIMEZONE });
});

/** First line of every Server Action and Route Handler. */
export async function requireUser(): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) throw new UnauthorizedError();
  return u;
}

async function upsertUser(input: {
  id: string;
  email: string;
  timezone: string;
}): Promise<CurrentUser> {
  const db = await getDb();
  const existing = await db.select().from(users).where(eq(users.id, input.id)).limit(1);
  const row = existing[0];
  if (row) return toCurrent(row);
  const inserted = await db
    .insert(users)
    .values({ id: input.id, email: input.email, timezone: input.timezone })
    .onConflictDoNothing()
    .returning();
  const created =
    inserted[0] ?? (await db.select().from(users).where(eq(users.id, input.id)).limit(1))[0];
  if (!created) throw new Error("users upsert failed");
  log.info("auth.user_created", { userId: created.id });
  return toCurrent(created);
}

function toCurrent(row: typeof users.$inferSelect): CurrentUser {
  return {
    id: row.id,
    email: row.email,
    timezone: row.timezone,
    displayName: row.displayName || null,
    onboardingCompletedAt: row.onboardingCompletedAt
      ? row.onboardingCompletedAt.toISOString()
      : null,
  };
}
