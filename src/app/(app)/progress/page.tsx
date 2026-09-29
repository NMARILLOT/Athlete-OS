import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getCurrentUser } from "@/server/auth";
import { getProgressView, isProgressRange } from "@/server/services/progress.service";
import { localDate } from "@/server/time";
import {
  CrossfitSection,
  DistributionSection,
  EngineSection,
  EnjoymentSection,
  ExposureSection,
  LoadSection,
  RangeChips,
  RecoverySection,
  StrengthSection,
  VolumeSection,
} from "@/components/progress/sections";

export const dynamic = "force-dynamic";
export const metadata = { title: "Progress" };

/**
 * Tab route: the transparent dashboards of spec §27 / §19 — volume, distribution, load, strength,
 * aerobic engine, CrossFit, recovery, enjoyment, weekly exposure. No composite score.
 */
export default async function ProgressPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/progress");
  if (!user.onboardingCompletedAt) redirect("/onboarding/1");
  const { range: rawRange } = await searchParams;
  const range = isProgressRange(rawRange) ? rawRange : "4w";
  const today = localDate(new Date(), user.timezone);
  const db = await getDb();
  const view = await getProgressView(db, user.id, range, today, { timezone: user.timezone });
  return (
    <section className="flex flex-col gap-4 py-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Progress</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Tableaux transparents, pas de score magique. « ≈ » signale une valeur estimée.
        </p>
      </div>
      <RangeChips active={view.range} />
      <VolumeSection volume={view.volume} />
      <DistributionSection distribution={view.distribution} />
      <LoadSection load={view.load} from={view.from} to={view.to} />
      <StrengthSection strength={view.strength} from={view.from} to={view.to} />
      <EngineSection engine={view.engine} from={view.from} to={view.to} />
      <CrossfitSection crossfit={view.crossfit} />
      <RecoverySection recovery={view.recovery} from={view.from} />
      <EnjoymentSection enjoyment={view.enjoyment} from={view.from} to={view.to} />
      <ExposureSection heatmap={view.heatmap} />
    </section>
  );
}
