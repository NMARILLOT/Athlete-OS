import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getCurrentUser } from "@/server/auth";
import { getWorkoutDetail } from "@/server/services/workout-detail.service";
import { PageHeader } from "@/components/ui/page-header";
import {
  ActivitiesBlock,
  AnalysisBlock,
  CardioBlock,
  CoachBlock,
  CrossfitBlock,
  StrengthBlock,
  WhyBlock,
  WorkoutHeader,
} from "@/components/workouts/workout-detail";
import { WorkoutActions } from "@/components/workouts/workout-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Séance" };

export default async function WorkoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/workouts/${id}`);
  const db = await getDb();
  const w = await getWorkoutDetail(db, user.id, id, user.timezone);
  if (!w) notFound();
  const score = w.crossfit?.score
    ? {
        kind: w.crossfit.score.kind,
        value: w.crossfit.score.value,
        extraReps: w.crossfit.score.extraReps ?? null,
        rx: w.crossfit.score.rx,
        scaledNotes: w.crossfit.score.scaledNotes ?? "",
      }
    : null;
  return (
    <section className="flex flex-col gap-4 py-2">
      <PageHeader title={w.title} />
      <WorkoutHeader w={w} />
      <WorkoutActions
        id={w.id}
        type={w.type}
        status={w.status}
        rpe={w.rpe}
        feeling={w.feeling}
        painReported={w.painReported}
        score={score}
      />
      {w.strength ? <StrengthBlock s={w.strength} /> : null}
      {w.crossfit ? <CrossfitBlock c={w.crossfit} /> : null}
      {w.cardio ? <CardioBlock c={w.cardio} /> : null}
      {w.coach ? <CoachBlock c={w.coach} /> : null}
      {w.why ? <WhyBlock why={w.why} /> : null}
      <AnalysisBlock planned={w.analysis.planned} actual={w.analysis.actual} />
      <ActivitiesBlock list={w.activities} />
    </section>
  );
}
