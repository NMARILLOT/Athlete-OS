import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getCurrentUser } from "@/server/auth";
import { getActivityDetail } from "@/server/services/activity.service";
import { LineChart, ZoneBars } from "@/components/activities/activity-charts";
import {
  ActivityHeader,
  ActivitySummary,
  DynamicsBlock,
  LapsTable,
  MetricsList,
  WorkoutLink,
} from "@/components/activities/activity-detail";
import { Card, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { formatPace } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Activité" };

export default async function ActivityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/activities/${id}`);
  const db = await getDb();
  const view = await getActivityDetail(db, user.id, id);
  if (!view) notFound();
  const { activity: a, streams, zones } = view;
  const hasChart = Boolean(streams.hr || streams.pace || streams.altitude || streams.power);
  const paceForModality = a.modality === "running" || a.modality === "walking";

  return (
    <section className="flex flex-col gap-4 py-2">
      <PageHeader title={a.title} />
      <ActivityHeader a={a} />
      <ActivitySummary a={a} />

      {hasChart ? (
        <Card>
          <CardTitle>Courbes</CardTitle>
          <div className="mt-3 flex flex-col gap-5">
            {streams.hr ? (
              <LineChart points={streams.hr} label="Fréquence cardiaque" unit="bpm" tone="hr" />
            ) : null}
            {streams.pace && paceForModality ? (
              <LineChart
                points={streams.pace}
                label="Allure"
                unit="/km"
                tone="pace"
                invert
                format={(v) => formatPace(v).replace(" /km", "")}
              />
            ) : null}
            {streams.power ? (
              <LineChart points={streams.power} label="Puissance" unit="W" tone="power" />
            ) : null}
            {streams.altitude ? (
              <LineChart points={streams.altitude} label="Altitude" unit="m" tone="altitude" />
            ) : null}
          </div>
          <p className="mt-3 text-[11px] text-fg-subtle">
            Courbes ré-échantillonnées pour l&apos;affichage ; les données complètes sont
            conservées.
          </p>
        </Card>
      ) : null}

      <Card>
        <CardTitle>Temps par zone</CardTitle>
        {zones ? (
          <div className="mt-3">
            <ZoneBars zones={zones.zones} timeInZones={zones.timeInZones} />
            <p className="mt-2 text-[11px] text-fg-subtle">
              Zones {zones.method === "lthr" ? "LTHR" : zones.method}
              {zones.lthr ? ` (${zones.lthr} bpm)` : ""} en vigueur ce jour-là · confiance{" "}
              {zones.confidence}
            </p>
          </div>
        ) : (
          <p className="mt-2 text-sm text-fg-muted">
            {streams.hr
              ? "Pas de zones : renseigne ta LTHR dans le profil."
              : "Pas de fréquence cardiaque sur cette activité."}
          </p>
        )}
      </Card>

      <LapsTable laps={view.laps} modality={a.modality} />
      <MetricsList metrics={view.metrics} />
      {a.runningDynamics ? <DynamicsBlock rd={a.runningDynamics} /> : null}
      <WorkoutLink workout={view.workout} />
    </section>
  );
}
