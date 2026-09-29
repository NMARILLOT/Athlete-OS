import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getCurrentUser } from "@/server/auth";
import { getProfileView } from "@/server/services/profile.service";
import { Card, CardTitle } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { IdentityForm } from "@/components/profile/identity-form";
import { FocusCard } from "@/components/profile/focus-card";
import { PreferencesForm } from "@/components/profile/preferences-form";
import { PainList } from "@/components/profile/pain-list";
import { FlagsList } from "@/components/profile/flags-list";
import { weightWord } from "@/components/profile/labels";
import { SignOutButton } from "@/components/profile/sign-out-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Profile" };

function RowLink({ href, title, hint }: { href: string; title: string; hint: string }) {
  return (
    <Link
      href={href}
      className="flex min-h-14 items-center justify-between gap-3 rounded-2xl border border-border bg-bg-elevated px-4 py-3 shadow-[var(--shadow-card)]"
    >
      <span className="min-w-0">
        <span className="block font-medium">{title}</span>
        <span className="block truncate text-xs text-fg-subtle">{hint}</span>
      </span>
      <span aria-hidden className="text-fg-subtle">
        →
      </span>
    </Link>
  );
}

/** /profile — tab route (plain h1, no back header), spec §34–36, §71, §101. */
export default async function ProfilePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/profile");
  const db = await getDb();
  const view = await getProfileView(db, user);
  const activeMedium = view.goals.medium.filter((g) => g.active);
  const g = view.integrations.garmin;

  return (
    <section className="flex flex-col gap-4 py-6">
      <h1 className="text-3xl font-semibold tracking-tight">Profile</h1>

      <IdentityForm
        displayName={view.user.displayName}
        timezone={view.user.timezone}
        email={view.user.email}
      />

      <FocusCard
        block={view.block}
        deload={view.deload}
        baselinePhase={view.profile.baselinePhase}
        baselinePhaseUntil={view.profile.baselinePhaseUntil}
      />

      <Card>
        <div className="flex items-center justify-between">
          <CardTitle>Objectifs</CardTitle>
          <Link
            href="/profile/goals"
            className="flex min-h-11 items-center text-sm font-semibold text-accent"
          >
            Modifier
          </Link>
        </div>
        {view.goals.usingDefaults ? (
          <p className="mt-1 text-xs text-fg-subtle">Pondération par défaut du moteur.</p>
        ) : null}
        <ul className="mt-2 flex flex-col gap-1.5">
          {view.goals.long.map((goal) => (
            <li key={goal.key} className="flex items-center gap-3 text-sm">
              <span className="w-32 shrink-0 truncate">{goal.title}</span>
              <span
                className="h-2 flex-1 overflow-hidden rounded-full bg-bg-muted"
                role="meter"
                aria-label={goal.title}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(goal.weight * 100)}
              >
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{ width: `${Math.round(goal.weight * 100)}%` }}
                />
              </span>
              <span className="w-20 shrink-0 text-right text-xs text-fg-muted">
                {weightWord(goal.weight)}
              </span>
            </li>
          ))}
        </ul>
        {activeMedium.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {activeMedium.map((goal) => (
              <Chip key={goal.key} tone="accent">
                {goal.title}
              </Chip>
            ))}
          </div>
        ) : null}
      </Card>

      <PreferencesForm
        preferences={view.preferences}
        weeklyHoursTarget={view.profile.weeklyHoursTarget}
      />

      <PainList pains={view.pains} />

      <RowLink
        href="/profile/integrations"
        title="Intégrations"
        hint={`Garmin ${g.provider} · ${g.flag ? "flag activé" : "flag désactivé"} · balance ${view.integrations.bodyComp.provider} · IA ${view.integrations.ai.provider}`}
      />
      <RowLink
        href="/profile/data"
        title="Données"
        hint="Exporter mes données · supprimer mon compte"
      />
      <RowLink
        href="/onboarding/1"
        title="Refaire l'onboarding"
        hint="Objectifs, sports, disponibilités, niveau, Garmin"
      />

      <FlagsList flags={view.flags} />

      <Card>
        <CardTitle>Session</CardTitle>
        {view.authMode === "supabase" ? (
          <SignOutButton />
        ) : (
          <p className="mt-2 text-sm text-fg-muted">Mode local — pas de session.</p>
        )}
      </Card>
    </section>
  );
}
