import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getCurrentUser } from "@/server/auth";
import { getProfileView } from "@/server/services/profile.service";
import { PageHeader } from "@/components/ui/page-header";
import { GoalsForm } from "@/components/profile/goals-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Objectifs" };

/** /profile/goals — weights editor (spec §34–35). The AI never changes these; only you do. */
export default async function ProfileGoalsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/profile/goals");
  const db = await getDb();
  const view = await getProfileView(db, user);
  return (
    <section className="py-2">
      <PageHeader title="Objectifs" closeHref="/profile" />
      <p className="mb-4 text-sm text-fg-muted">
        Ces poids orientent les stimuli hebdomadaires. Une dominante ne fait jamais disparaître les
        autres capacités, et l&apos;IA ne modifie jamais ces priorités sans ton accord.
      </p>
      <GoalsForm
        mode="profile"
        long={view.goals.long}
        medium={view.goals.medium}
        usingDefaults={view.goals.usingDefaults}
      />
    </section>
  );
}
