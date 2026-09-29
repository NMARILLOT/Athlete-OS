import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { getCurrentUser } from "@/server/auth";
import { getCardioWorkout } from "@/server/services/cardio.service";
import {
  CardioDoneCard,
  CardioSummary,
  CardioTimeline,
  ExpectedLoadCard,
} from "@/components/cardio/cardio-detail";
import { CardioSessionActions } from "@/components/cardio/cardio-session-actions";
import { GarminCard } from "@/components/cardio/garmin-card";
import { PageHeader } from "@/components/ui/page-header";

export const dynamic = "force-dynamic";
export const metadata = { title: "Séance cardio" };

/** Cardio session page (ARCHITECTURE §3 `/train/cardio/[id]`): timeline, Garmin push, start / finish. */
export default async function CardioWorkoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/train/cardio/${id}`);
  if (!z.string().uuid().safeParse(id).success) notFound();
  const db = await getDb();
  const view = await getCardioWorkout(db, user.id, id, { timezone: user.timezone });
  if (!view) notFound();

  const editable = view.status === "planned" || view.status === "auto_adjusted";
  const sendable = view.status !== "done" && view.status !== "skipped";

  return (
    <section className="flex flex-col gap-4 py-2 pb-8">
      <PageHeader
        title={view.title}
        action={
          editable ? (
            <Link
              href={`/train/cardio/new?edit=${view.id}`}
              className="inline-flex h-11 items-center rounded-xl px-3 text-sm font-semibold text-accent"
            >
              Modifier
            </Link>
          ) : undefined
        }
      />
      <CardioSummary view={view} />
      {view.status === "done" ? <CardioDoneCard view={view} /> : null}
      <CardioSessionActions
        id={view.id}
        status={view.status}
        startAt={view.startAt}
        plannedDurationMin={view.plannedDurationMin}
      />
      <CardioTimeline steps={view.flatSteps} hasZones={view.zoneSet !== null} />
      <ExpectedLoadCard load={view.expectedLoad} />
      <GarminCard workoutId={view.id} garmin={view.garmin} sendable={sendable} />
    </section>
  );
}
