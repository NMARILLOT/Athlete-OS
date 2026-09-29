import Link from "next/link";
import type { ReactNode } from "react";
import { ONBOARDING_STEP_COUNT, ONBOARDING_STEPS } from "@/components/profile/labels";
import { cn } from "@/lib/cn";

/** Progress bar + title + "Passer" for every onboarding step (spec §89: short onboarding). */
export function OnboardingShell({
  step,
  children,
  skip,
}: {
  step: number;
  children: ReactNode;
  /** Custom skip control (last step); default is a link to the next step. */
  skip?: ReactNode;
}) {
  const meta = ONBOARDING_STEPS.find((s) => s.step === step);
  const nextHref = step < ONBOARDING_STEP_COUNT ? `/onboarding/${step + 1}` : "/today";
  return (
    <section className="flex flex-col gap-4 py-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold tracking-[0.14em] text-fg-muted uppercase">
          Étape {step}/{ONBOARDING_STEP_COUNT}
        </p>
        {skip ?? (
          <Link
            href={nextHref}
            className="flex min-h-11 items-center rounded-xl px-3 text-sm font-semibold text-fg-muted hover:text-fg"
          >
            Passer
          </Link>
        )}
      </div>
      <ol className="flex gap-1.5" aria-label="Progression">
        {ONBOARDING_STEPS.map((s) => (
          <li
            key={s.step}
            aria-current={s.step === step ? "step" : undefined}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              s.step < step ? "bg-accent" : s.step === step ? "bg-accent/60" : "bg-bg-muted",
            )}
          />
        ))}
      </ol>
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{meta?.title ?? "Onboarding"}</h1>
        {meta?.hint ? <p className="mt-1 text-fg-muted">{meta.hint}</p> : null}
      </div>
      {children}
    </section>
  );
}
