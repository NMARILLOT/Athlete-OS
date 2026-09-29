import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/db/client";
import { athleteProfiles } from "@/db/schema";
import { CARDIO_PRESET_KINDS, type CardioPresetKind } from "@/domain/cardio";
import { isIsoDate } from "@/domain/core/dates";
import { getCurrentUser } from "@/server/auth";
import { getCardioWorkout, resolveZoneSet } from "@/server/services/cardio.service";
import { localDate } from "@/server/time";
import { CardioBuilder } from "@/components/cardio/cardio-builder";
import { PageHeader } from "@/components/ui/page-header";
import { clockFromMinutes } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Séance cardio" };

function presetOf(value: string | undefined): CardioPresetKind | null {
  return value && (CARDIO_PRESET_KINDS as readonly string[]).includes(value)
    ? (value as CardioPresetKind)
    : null;
}

/**
 * Cardio builder (ARCHITECTURE §3 `/train/cardio/new`): `?preset=<kind>` preselects a preset,
 * `?date=YYYY-MM-DD` the day, `?edit=<workoutId>` loads a planned workout's spec for editing.
 */
export default async function NewCardioPage({
  searchParams,
}: {
  searchParams: Promise<{ preset?: string; date?: string; edit?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/train/cardio/new");
  const { preset, date, edit } = await searchParams;
  const db = await getDb();
  const today = localDate(new Date(), user.timezone);

  if (edit) {
    if (!z.string().uuid().safeParse(edit).success) notFound();
    const view = await getCardioWorkout(db, user.id, edit, { timezone: user.timezone });
    if (!view) notFound();
    if (view.status !== "planned" && view.status !== "auto_adjusted")
      redirect(`/train/cardio/${view.id}`);
    return (
      <section className="py-2">
        <PageHeader title="Modifier la séance" closeHref={`/train/cardio/${view.id}`} />
        <CardioBuilder
          defaultDate={view.date}
          defaultStart={view.startMinute != null ? clockFromMinutes(view.startMinute) : ""}
          initialPreset={null}
          initialSpec={view.spec}
          editId={view.id}
          zones={view.zoneSet?.zones ?? null}
        />
      </section>
    );
  }

  const defaultDate = date && isIsoDate(date) ? date : today;
  const [profile] = await db
    .select({ times: athleteProfiles.preferredTrainingTimes })
    .from(athleteProfiles)
    .where(eq(athleteProfiles.userId, user.id))
    .limit(1);
  const zoneSet = await resolveZoneSet(db, user.id, defaultDate);
  return (
    <section className="py-2">
      <PageHeader title="Nouvelle séance cardio" closeHref="/train" />
      <CardioBuilder
        defaultDate={defaultDate}
        defaultStart={profile?.times.cardio ?? "18:00"}
        initialPreset={presetOf(preset)}
        initialSpec={null}
        editId={null}
        zones={zoneSet?.zones ?? null}
      />
    </section>
  );
}
