import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getCurrentUser } from "@/server/auth";
import { getProfileView } from "@/server/services/profile.service";
import { Card, CardTitle } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateShort } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Intégrations" };

function Kv({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex items-center justify-between gap-3 text-sm">
      <span className="text-fg-muted">{label}</span>
      <span className="font-medium">{value}</span>
    </li>
  );
}

/** /profile/integrations — read-only status of every provider (spec §13–14, §26, §101). */
export default async function ProfileIntegrationsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/profile/integrations");
  const db = await getDb();
  const view = await getProfileView(db, user);
  const { garmin, bodyComp, ai } = view.integrations;

  return (
    <section className="py-2">
      <PageHeader title="Intégrations" closeHref="/profile" />
      <p className="mb-4 text-sm text-fg-muted">
        Tout se configure côté serveur (variables d&apos;environnement) : aucune clé API ne transite
        par le téléphone.
      </p>
      <div className="flex flex-col gap-4">
        <Card>
          <div className="flex items-center justify-between">
            <CardTitle>Garmin</CardTitle>
            <Chip tone={garmin.flag ? "accent" : "neutral"}>
              {garmin.flag ? "Flag activé" : "Flag désactivé"}
            </Chip>
          </div>
          <ul className="mt-3 flex flex-col gap-1.5">
            <Kv label="Fournisseur" value={garmin.provider === "official" ? "Officiel" : "Mock"} />
            <Kv
              label="Connexion (fournisseur)"
              value={garmin.providerConnected ? "Connecté" : "Non connecté"}
            />
            <Kv label="Statut du compte" value={garmin.status ?? "—"} />
            <Kv
              label="Connecté le"
              value={garmin.connectedAt ? formatDateShort(garmin.connectedAt.slice(0, 10)) : "—"}
            />
            <Kv
              label="Dernière synchro"
              value={garmin.lastSyncAt ? formatDateShort(garmin.lastSyncAt.slice(0, 10)) : "—"}
            />
          </ul>
          <p className="mt-3 text-xs text-fg-subtle">
            {garmin.provider === "mock"
              ? "Le mock génère des activités et des données santé réalistes pour le développement. La connexion officielle demande l'approbation du Garmin Developer Program, puis GARMIN_PROVIDER=official, GARMIN_CLIENT_ID, GARMIN_CLIENT_SECRET, GARMIN_REDIRECT_URI et FLAG_GARMIN=true."
              : "Fournisseur officiel sélectionné. Les identifiants Garmin (GARMIN_CLIENT_ID / SECRET / REDIRECT_URI) et FLAG_GARMIN doivent être définis côté serveur."}
          </p>
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <CardTitle>Balance</CardTitle>
            <Chip tone={bodyComp.flag ? "accent" : "neutral"}>
              {bodyComp.flag ? "Flag activé" : "Flag désactivé"}
            </Chip>
          </div>
          <ul className="mt-3 flex flex-col gap-1.5">
            <Kv
              label="Fournisseur"
              value={
                bodyComp.provider === "manual"
                  ? "Manuel"
                  : bodyComp.provider === "withings"
                    ? "Withings"
                    : "Garmin"
              }
            />
          </ul>
          <p className="mt-3 text-xs text-fg-subtle">
            {bodyComp.provider === "manual"
              ? "Saisie manuelle via + → Mesure corporelle. Une balance connectée passera par BODYCOMP_PROVIDER=withings ou garmin une fois l'API vendeur enregistrée, avec FLAG_BODY_COMP=true."
              : "Fournisseur connecté sélectionné : l'API vendeur doit être enregistrée et FLAG_BODY_COMP activé."}
          </p>
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <CardTitle>IA</CardTitle>
            <Chip tone={ai.coachFlag ? "accent" : "neutral"}>
              {ai.coachFlag ? "Coach activé" : "Coach désactivé"}
            </Chip>
          </div>
          <ul className="mt-3 flex flex-col gap-1.5">
            <Kv label="Fournisseur" value={ai.provider === "anthropic" ? "Anthropic" : "Mock"} />
            <Kv
              label="Analyse des WOD"
              value={ai.provider === "anthropic" ? "IA" : "Heuristique"}
            />
          </ul>
          <p className="mt-3 text-xs text-fg-subtle">
            L&apos;IA ne fait que traduire (structure d&apos;un WOD, intention, formulation) : la
            planification reste déterministe. AI_PROVIDER=anthropic + ANTHROPIC_API_KEY activent le
            parseur IA (repli heuristique automatique) ; FLAG_AI_COACH=true active le chat et les
            explications.
          </p>
        </Card>
      </div>
    </section>
  );
}
