import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Tone =
  | "neutral"
  | "accent"
  | "crossfit"
  | "strength"
  | "cardioEasy"
  | "cardioHard"
  | "recovery"
  | "coaching"
  | "warn"
  | "danger"
  | "info";

const TONE: Record<Tone, string> = {
  neutral: "bg-bg-muted text-fg-muted",
  accent: "bg-accent/15 text-accent",
  crossfit: "bg-crossfit/15 text-crossfit",
  strength: "bg-strength/15 text-strength",
  cardioEasy: "bg-cardio-easy/15 text-cardio-easy",
  cardioHard: "bg-cardio-hard/15 text-cardio-hard",
  recovery: "bg-recovery/15 text-recovery",
  coaching: "bg-coaching/15 text-coaching",
  warn: "bg-warn/15 text-warn",
  danger: "bg-danger/15 text-danger",
  info: "bg-info/15 text-info",
};

export function Chip({
  tone = "neutral",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center rounded-full px-2.5 text-xs font-semibold",
        TONE[tone],
        className,
      )}
      {...props}
    />
  );
}

/** Tone for a workout type / family (single mapping used across screens). */
export function toneFor(kind: string, intensity?: string | null): Tone {
  if (kind.includes("crossfit") || kind === "partner" || kind === "benchmark") return "crossfit";
  if (
    kind.startsWith("strength") ||
    kind === "accessory" ||
    kind === "olympic" ||
    kind === "gymnastics"
  )
    return "strength";
  if (kind === "coach_session") return "coaching";
  if (
    kind === "rest" ||
    kind === "mobility" ||
    kind.includes("recovery") ||
    kind === "walk" ||
    kind === "just_move"
  )
    return "recovery";
  if (intensity === "hard" || intensity === "moderate") return "cardioHard";
  return "cardioEasy";
}
