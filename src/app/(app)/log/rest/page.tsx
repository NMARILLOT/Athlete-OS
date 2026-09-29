import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { localDate } from "@/server/time";
import { PageHeader } from "@/components/ui/page-header";
import { RestForm } from "@/components/log/rest-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Jour de repos" };

export default async function LogRestPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/log/rest");
  return (
    <section className="py-2">
      <PageHeader title="Jour de repos" closeHref="/today" />
      <RestForm today={localDate(new Date(), user.timezone)} />
    </section>
  );
}
