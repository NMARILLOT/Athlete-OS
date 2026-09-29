import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { athleteProfiles } from "@/db/schema";
import { getCurrentUser } from "@/server/auth";
import { localDate } from "@/server/time";
import { PageHeader } from "@/components/ui/page-header";
import { CoachForm } from "@/components/log/coach-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Coaching CrossFit" };

export default async function LogCoachPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/log/coach");
  const db = await getDb();
  const [profile] = await db
    .select({ preferredTrainingTimes: athleteProfiles.preferredTrainingTimes })
    .from(athleteProfiles)
    .where(eq(athleteProfiles.userId, user.id))
    .limit(1);
  const preferred = profile?.preferredTrainingTimes.crossfit;
  const defaultStart = preferred && /^\d{2}:\d{2}$/.test(preferred) ? preferred : "18:00";
  return (
    <section className="py-2">
      <PageHeader title="Coaching CrossFit" closeHref="/today" />
      <CoachForm today={localDate(new Date(), user.timezone)} defaultStart={defaultStart} />
    </section>
  );
}
