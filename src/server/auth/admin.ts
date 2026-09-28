import "server-only";
import { createClient } from "@supabase/supabase-js";
import { env } from "@/server/env";
import { NotConfiguredError } from "@/server/errors";

/**
 * The ONLY module allowed to import the service-role key (ARCHITECTURE §7). Used for account deletion.
 */
export async function deleteAuthUser(userId: string): Promise<void> {
  const e = env();
  if (e.AUTH_MODE !== "supabase") return;
  if (!e.NEXT_PUBLIC_SUPABASE_URL || !e.SUPABASE_SERVICE_ROLE_KEY)
    throw new NotConfiguredError("Supabase service role");
  const admin = createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) throw new Error(`auth.admin.deleteUser failed: ${error.status ?? ""}`);
}
