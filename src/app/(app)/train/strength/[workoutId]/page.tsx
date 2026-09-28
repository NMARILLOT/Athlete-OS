import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getCurrentUser } from "@/server/auth";
import { getStrengthBundle } from "@/server/services/strength-session.service";
import { StrengthSessionShell } from "@/components/strength/strength-session-shell";
import { NotFoundError } from "@/server/errors";

export const dynamic = "force-dynamic";
export const metadata = { title: "Séance" };

/**
 * The bundle is fetched here when online; the shell hydrates from IndexedDB first and only uses the
 * bundle to seed a new session (ARCHITECTURE §4). When offline, the SW serves the cached shell.
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
  let bundle = null;
  try {
    const b = await getStrengthBundle(db, user.id, workoutId);
    bundle = {
      workoutId: b.workoutId,
      title: b.title,
      date: b.date,
      templateId: b.templateId,
      exercises: b.exercises,
    };
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
  }
  return <StrengthSessionShell bundle={bundle} workoutId={workoutId} />;
}
