import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { localDate } from "@/server/time";
import { PageHeader } from "@/components/ui/page-header";
import { ActivityForm } from "@/components/log/activity-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Enregistrer une activité" };

export default async function LogActivityPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/log/activity");
  return (
    <section className="py-2">
      <PageHeader title="Enregistrer une activité" closeHref="/today" />
      <ActivityForm today={localDate(new Date(), user.timezone)} />
    </section>
  );
}
