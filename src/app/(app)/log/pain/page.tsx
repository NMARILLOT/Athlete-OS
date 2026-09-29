import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getCurrentUser } from "@/server/auth";
import { listActivePains } from "@/server/services/log.service";
import { PageHeader } from "@/components/ui/page-header";
import { PainForm } from "@/components/log/pain-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Douleur" };

export default async function LogPainPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/log/pain");
  const db = await getDb();
  const active = await listActivePains(db, user.id);
  return (
    <section className="py-2">
      <PageHeader title="Signaler une douleur" closeHref="/today" />
      <PainForm active={active} />
    </section>
  );
}
