import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { isIsoDate, isoWeekStart } from "@/domain/core/dates";
import { getCurrentUser } from "@/server/auth";
import { getCalendarWeek } from "@/server/services/calendar.service";
import { localDate } from "@/server/time";
import { WeekView } from "@/components/calendar/week-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Calendar" };

/** Tab route: week view = real workouts + engine outlook, move with verification (spec §53). */
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/calendar");
  if (!user.onboardingCompletedAt) redirect("/onboarding/1");
  const { week } = await searchParams;
  const now = new Date();
  const today = localDate(now, user.timezone);
  const weekStart = isoWeekStart(week && isIsoDate(week) ? week : today);
  const db = await getDb();
  const view = await getCalendarWeek(db, user, weekStart, now);
  return (
    <section className="flex flex-col gap-4 py-6">
      <h1 className="text-3xl font-semibold tracking-tight">Calendar</h1>
      <WeekView week={view} />
    </section>
  );
}
