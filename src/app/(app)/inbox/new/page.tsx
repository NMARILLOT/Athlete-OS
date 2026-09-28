import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { athleteProfiles } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/server/auth";
import { localDate } from "@/server/time";
import { PageHeader } from "@/components/ui/page-header";
import { NewWodForm } from "@/components/inbox/new-wod-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Nouveau WOD" };

export default async function NewWodPage({
  searchParams,
}: {
  searchParams: Promise<{ for?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/inbox/new");
  const { for: forDate } = await searchParams;
  const db = await getDb();
  const [profile] = await db
    .select({ times: athleteProfiles.preferredTrainingTimes })
    .from(athleteProfiles)
    .where(eq(athleteProfiles.userId, user.id))
    .limit(1);
  const defaultStart = (profile?.times as { crossfit?: string } | null)?.crossfit ?? "18:30";
  return (
    <section className="py-2">
      <PageHeader title="Quel est le WOD ?" closeHref="/today" />
      <NewWodForm
        defaultDate={forDate ?? localDate(new Date(), user.timezone)}
        defaultStart={defaultStart}
      />
    </section>
  );
}
