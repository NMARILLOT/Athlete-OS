import { z } from "zod";

export const SET_QUALITY_VALUES = ["easy", "perfect", "hard", "failed"] as const;
export type SetQuality = (typeof SET_QUALITY_VALUES)[number];

/** Quick post-set feedback → RPE (documented mapping, spec §10/§77). */
export const QUALITY_TO_RPE: Record<SetQuality, number> = {
  easy: 6.5,
  perfect: 8,
  hard: 9.5,
  failed: 10,
};

export const SET_INTENT_VALUES = ["strength", "hypertrophy", "power", "skill", "circuit"] as const;
export type SetIntent = (typeof SET_INTENT_VALUES)[number];

export const StrengthPrescriptionSchema = z.object({
  sets: z.number().int().min(1).max(20),
  repMin: z.number().int().min(1).max(50),
  repMax: z.number().int().min(1).max(50),
  /** Target RPE range for working sets. */
  targetRpeMin: z.number().min(5).max(10).default(7),
  targetRpeMax: z.number().min(5).max(10).default(8.5),
  intent: z.enum(SET_INTENT_VALUES).default("strength"),
  /** Suggested load computed by the progression engine, in kg. Null when unknown. */
  loadSuggestionKg: z.number().nonnegative().nullable().default(null),
  /** Rest seconds override; when null, the rest-timer policy decides from `intent`. */
  restSec: z.number().int().positive().nullable().default(null),
  notes: z.string().max(500).optional(),
});
export type StrengthPrescription = z.infer<typeof StrengthPrescriptionSchema>;

export interface SetRecord {
  reps: number;
  weightKg: number;
  /** 1..10 when captured. */
  rpe?: number | null;
  quality?: SetQuality | null;
  isWarmup?: boolean;
  completedAt?: string;
}

export interface ExposureRecord {
  /** ISO date of the exposure. */
  date: string;
  sets: SetRecord[];
  prescription?: Partial<StrengthPrescription>;
}
