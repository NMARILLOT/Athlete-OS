import { Card, CardTitle } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { FLAG_KEYS, FLAG_LABEL_FR, type FlagKey } from "@/components/profile/labels";

/** Read-only feature flags (spec §101): set via FLAG_* env vars, never from the UI. */
export function FlagsList({ flags }: { flags: Readonly<Record<FlagKey, boolean>> }) {
  return (
    <Card>
      <CardTitle>Feature flags</CardTitle>
      <p className="mt-1 text-xs text-fg-subtle">
        Lecture seule — configurés par les variables d&apos;environnement <code>FLAG_*</code>.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {FLAG_KEYS.map((key) => {
          const on = flags[key];
          const meta = FLAG_LABEL_FR[key];
          return (
            <li key={key} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{meta.label}</p>
                {meta.hint ? <p className="text-xs text-fg-subtle">{meta.hint}</p> : null}
              </div>
              <Chip tone={on ? "accent" : "neutral"}>{on ? "Activé" : "Désactivé"}</Chip>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
