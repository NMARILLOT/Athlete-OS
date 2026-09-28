import Link from "next/link";
import { STRENGTH_TEMPLATES } from "@/domain/strength";
import { Card, CardTitle } from "@/components/ui/card";
import { StartTemplateButton } from "@/components/strength/start-template-button";

export const metadata = { title: "Train" };

export default function TrainPage() {
  return (
    <section className="flex flex-col gap-4 py-6">
      <h1 className="text-3xl font-semibold tracking-tight">Train</h1>
      <Card>
        <CardTitle>Strength</CardTitle>
        <ul className="mt-2 flex flex-col gap-2">
          {STRENGTH_TEMPLATES.map((t) => (
            <li key={t.id} className="flex items-center justify-between">
              <div>
                <p className="font-medium">{t.name}</p>
                <p className="text-xs text-fg-muted">
                  {t.durationMin} min ·{" "}
                  {t.exercises.map((e) => e.exerciseId.replace(/_/g, " ")).join(", ")}
                </p>
              </div>
              <StartTemplateButton templateId={t.id} />
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <CardTitle>Cardio</CardTitle>
        <p className="mt-2 text-sm text-fg-muted">
          Zone 2, seuil, VO2max, intervalles — construis une séance et envoie-la vers Garmin (mock
          pour l&apos;instant).
        </p>
        <Link href="/train/cardio/new" className="mt-3 inline-block font-semibold text-accent">
          Nouvelle séance cardio →
        </Link>
      </Card>
      <Card>
        <CardTitle>CrossFit</CardTitle>
        <p className="mt-2 text-sm text-fg-muted">
          Colle le WOD de ta box : l&apos;app l&apos;analyse et replanifie le reste de la semaine.
        </p>
        <Link href="/inbox/new" className="mt-3 inline-block font-semibold text-accent">
          Ajouter un WOD →
        </Link>
      </Card>
      <Card>
        <CardTitle>Free</CardTitle>
        <p className="mt-2 text-sm text-fg-muted">
          Marche, sport collectif, trail improvisé : enregistre une activité libre.
        </p>
        <Link href="/log/activity" className="mt-3 inline-block font-semibold text-accent">
          Enregistrer une activité →
        </Link>
      </Card>
    </section>
  );
}
