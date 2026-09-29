import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getCurrentUser } from "@/server/auth";
import { getProfileView, ONBOARDING_PR_LIFTS } from "@/server/services/profile.service";
import { Card, CardTitle } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { SportsStep } from "@/components/onboarding/sports-step";
import { AvailabilityStep } from "@/components/onboarding/availability-step";
import { LevelStep } from "@/components/onboarding/level-step";
import { GoalsForm } from "@/components/profile/goals-form";
import { SubmitButton } from "@/components/profile/submit-button";
import { ONBOARDING_STEP_COUNT } from "@/components/profile/labels";
import { finishOnboardingAction } from "../actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Onboarding" };

/**
 * /onboarding/[step] — five short steps (spec §89): objectifs, sports & matériel,
 * disponibilités, niveau / PR, Garmin. Each step loads the stored values so it can be revisited.
 */
export default async function OnboardingStepPage({
  params,
}: {
  params: Promise<{ step: string }>;
}) {
  const { step } = await params;
  const n = /^\d+$/.test(step) ? Number(step) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > ONBOARDING_STEP_COUNT) notFound();
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/onboarding/${n}`);
  const db = await getDb();
  const view = await getProfileView(db, user);

  if (n === 1) {
    return (
      <OnboardingShell step={1}>
        <GoalsForm
          mode="onboarding"
          long={view.goals.long}
          medium={view.goals.medium}
          usingDefaults={view.goals.usingDefaults}
        />
      </OnboardingShell>
    );
  }
  if (n === 2) {
    return (
      <OnboardingShell step={2}>
        <SportsStep
          favouriteModalities={view.preferences.favouriteModalities}
          facilities={view.profile.facilities}
          equipment={view.profile.equipment}
          preferredTrainingTimes={view.profile.preferredTrainingTimes}
        />
      </OnboardingShell>
    );
  }
  if (n === 3) {
    return (
      <OnboardingShell step={3}>
        <AvailabilityStep
          weeklyHoursTarget={view.profile.weeklyHoursTarget}
          maxHardSessionsPerWeek={view.preferences.maxHardSessionsPerWeek}
          windows={view.availability}
        />
      </OnboardingShell>
    );
  }
  if (n === 4) {
    return (
      <OnboardingShell step={4}>
        <LevelStep
          lifts={ONBOARDING_PR_LIFTS}
          declaredPrs={view.declaredPrs}
          lthrManual={view.profile.lthrManual}
          maxHrManual={view.profile.maxHrManual}
          restingHrManual={view.profile.restingHrManual}
          bodyweightKg={view.profile.bodyweightKg}
        />
      </OnboardingShell>
    );
  }

  const g = view.integrations.garmin;
  return (
    <OnboardingShell
      step={5}
      skip={
        <form action={finishOnboardingAction}>
          <SubmitButton variant="ghost" size="sm" pendingLabel="…">
            Passer
          </SubmitButton>
        </form>
      }
    >
      <Card>
        <CardTitle>Garmin</CardTitle>
        <div className="mt-2 flex flex-wrap gap-2">
          <Chip tone={g.provider === "official" ? "accent" : "neutral"}>
            Fournisseur : {g.provider === "official" ? "officiel" : "mock"}
          </Chip>
          <Chip tone={g.flag ? "accent" : "neutral"}>
            Flag Garmin {g.flag ? "activé" : "désactivé"}
          </Chip>
          {g.status ? <Chip tone="info">Statut : {g.status}</Chip> : null}
        </div>
        <p className="mt-3 text-sm text-fg-muted">
          La connexion Garmin officielle passe par le Garmin Developer Program (Health, Activity et
          Training APIs) : elle nécessite une approbation externe avant d&apos;être activée. En
          attendant, l&apos;app fonctionne avec des données simulées et tu peux importer tes
          fichiers .FIT depuis Garmin Connect.
        </p>
        <p className="mt-2 text-sm text-fg-muted">
          Tu pourras suivre l&apos;état de la connexion dans{" "}
          <Link href="/profile/integrations" className="font-semibold text-accent">
            Profil → Intégrations
          </Link>
          .
        </p>
      </Card>
      <Card>
        <CardTitle>Les 3 premières semaines</CardTitle>
        <p className="mt-2 text-sm text-fg-muted">
          Athlete OS apprend ton profil : les recommandations restent prudentes le temps de
          collecter tes premières séances. Tu peux modifier tout ce que tu viens de renseigner
          depuis ton profil.
        </p>
      </Card>
      <form action={finishOnboardingAction}>
        <SubmitButton size="lg" full pendingLabel="Préparation de ta première journée…">
          Terminer
        </SubmitButton>
      </form>
    </OnboardingShell>
  );
}
