import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getCurrentUser } from "@/server/auth";
import { getStrengthBundle } from "@/server/services/strength-session.service";
import { StrengthSessionShell } from "@/components/strength/strength-session-shell";
import type { StrengthBundle } from "@/stores/strength-session";
import { NotFoundError } from "@/server/errors";

export const dynamic = "force-dynamic";
export const metadata = { title: "Séance" };

/**
 * The bundle is fetched here when online; the shell hydrates from IndexedDB first and only uses the
 * bundle to seed a new session (ARCHITECTURE §4). The bundle carries the server `status` (a done
 * workout is never re-seeded) and the already-synced sets (resume when IndexedDB is empty).
 * When offline, the SW serves the cached shell.
 */
export default async function StrengthSessionPage({
  params,
}: {
  params: Promise<{ workoutId: string }>;
}) {
  const { workoutId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/train/strength/${workoutId}`);
  const db = await getDb();
  let bundle: StrengthBundle | null = null;
  try {
    const b = await getStrengthBundle(db, user.id, workoutId);
    bundle = {
      workoutId: b.workoutId,
      title: b.title,
      date: b.date,
      templateId: b.templateId,
      status: b.status,
      startedAt: b.startedAt,
      exercises: b.exercises,
      sets: b.sets,
    };
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
  }
  return <StrengthSessionShell bundle={bundle} workoutId={workoutId} userId={user.id} />;
}
