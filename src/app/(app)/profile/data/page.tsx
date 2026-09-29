import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getCurrentUser } from "@/server/auth";
import { getProfileView } from "@/server/services/profile.service";
import { PageHeader } from "@/components/ui/page-header";
import { DataTools } from "@/components/profile/data-tools";

export const dynamic = "force-dynamic";
export const metadata = { title: "Données" };

/** /profile/data — export & delete (spec §71, ARCHITECTURE §7 "Privacy lifecycle"). */
export default async function ProfileDataPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/profile/data");
  const db = await getDb();
  const view = await getProfileView(db, user);
  return (
    <section className="py-2">
      <PageHeader title="Données" closeHref="/profile" />
      <p className="mb-4 text-sm text-fg-muted">
        Tes données t&apos;appartiennent : tu peux les exporter à tout moment ou tout supprimer.
      </p>
      <DataTools authMode={view.authMode} />
    </section>
  );
}
