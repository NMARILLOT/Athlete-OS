import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getCurrentUser } from "@/server/auth";
import { listRecentBodyCompositions } from "@/server/services/log.service";
import { localDate, localMinute } from "@/server/time";
import { minutesToClock } from "@/domain/core/dates";
import { PageHeader } from "@/components/ui/page-header";
import { BodyForm } from "@/components/log/body-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mesure corporelle" };

export default async function LogBodyPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/log/body");
  const db = await getDb();
  const now = new Date();
  const recent = await listRecentBodyCompositions(db, user.id, 8);
  const nowLocal = `${localDate(now, user.timezone)}T${minutesToClock(localMinute(now, user.timezone))}`;
  return (
    <section className="py-2">
      <PageHeader title="Mesure corporelle" closeHref="/today" />
      <BodyForm nowLocal={nowLocal} recent={recent} />
    </section>
  );
}
