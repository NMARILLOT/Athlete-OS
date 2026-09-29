import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getCurrentUser } from "@/server/auth";
import { flags } from "@/server/flags";
import { garminProvider } from "@/server/providers/garmin";
import { listActivities } from "@/server/services/activity.service";
import { ActivityList } from "@/components/activities/activity-list";
import { GarminSyncButton } from "@/components/activities/garmin-sync-button";
import { PageHeader } from "@/components/ui/page-header";

export const dynamic = "force-dynamic";
export const metadata = { title: "Activités" };

export default async function ActivitiesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/activities");
  const db = await getDb();
  const items = await listActivities(db, user.id, 50);
  const garmin = flags().garmin;
  return (
    <section className="py-2">
      <PageHeader title="Activités" closeHref="/today" />
      <div className="mb-4 flex flex-col gap-2">
        <Link
          href="/activities/import"
          className="inline-flex h-12 items-center justify-center rounded-xl bg-accent px-4 font-semibold text-accent-fg hover:bg-accent-strong"
        >
          Importer un fichier FIT
        </Link>
        {garmin ? <GarminSyncButton providerName={garminProvider().name} /> : null}
      </div>
      <ActivityList items={items} />
    </section>
  );
}
