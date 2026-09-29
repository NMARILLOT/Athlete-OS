import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getCurrentUser } from "@/server/auth";
import { NotFoundError } from "@/server/errors";
import { getExercisePage } from "@/server/services/exercise.service";
import type { ExercisePageView } from "@/server/services/view-models";
import { localDate } from "@/server/time";
import { PageHeader } from "@/components/ui/page-header";
import {
  ExerciseHistory,
  ExerciseStats,
  RecentLoadsChart,
} from "@/components/progress/exercise-sections";

export const dynamic = "force-dynamic";
export const metadata = { title: "Exercice" };

/** Detail page of one movement (spec §28): stats, recent loads chart, set history. */
export default async function ExercisePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/exercises/${id}`);
  const db = await getDb();
  const today = localDate(new Date(), user.timezone);
  let view: ExercisePageView;
  try {
    view = await getExercisePage(db, user.id, id, today);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  return (
    <section className="flex flex-col gap-4 py-2">
      <PageHeader title={view.name} />
      <ExerciseStats view={view} />
      <RecentLoadsChart loads={view.recentLoads} />
      <ExerciseHistory history={view.history} />
    </section>
  );
}
