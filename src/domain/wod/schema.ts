import { z } from "zod";
import { MOVEMENT_PATTERN_VALUES } from "../core";

/**
 * NormalizedWod — STRUCTURE ONLY (ENGINE.md §9, ADR-004).
 * The AI/heuristic parser may only describe what the WOD says: movements, reps, loads, formats,
 * durations. All physiology (patterns, muscles, energy systems, intensity, credits) is derived by the
 * deterministic WodAnalyzer from the exercise catalog. The schemas are `.strict()` so that any
 * physiology key sneaking in from a model output is rejected at validation time.
 */

export const WOD_FORMAT_VALUES = [
  "for_time",
  "amrap",
  "emom",
  "intervals",
  "sets_reps",
  "tabata",
  "chipper",
  "ladder",
  "not_timed",
] as const;
export type WodFormat = (typeof WOD_FORMAT_VALUES)[number];

export const WOD_PART_KIND_VALUES = [
  "warmup",
  "strength",
  "skill",
  "metcon",
  "accessory",
  "cooldown",
] as const;
export type WodPartKind = (typeof WOD_PART_KIND_VALUES)[number];

export const WodLoadSchema = z
  .object({
    value: z.number().nonnegative(),
    unit: z.enum(["kg", "lb", "percent_1rm", "bodyweight_ratio", "pood"]),
    /** Second prescribed load when written "43/30" (usually the women's Rx). */
    alt: z.number().nonnegative().nullable().default(null),
    /** Free qualifier: "heavy", "light", "moderate", "build". */
    qualifier: z.enum(["light", "moderate", "heavy", "build"]).nullable().default(null),
  })
  .strict();
export type WodLoad = z.infer<typeof WodLoadSchema>;

export const WodMovementSchema = z
  .object({
    /** Text as written. */
    raw: z.string().min(1).max(200),
    /** Catalog id when resolved; null when unknown. */
    exerciseId: z.string().nullable(),
    /** Display name (resolved catalog name or raw). */
    name: z.string().min(1).max(120),
    /** Confidence of the exercise resolution 0..1 (1 = exact alias). */
    resolutionConfidence: z.number().min(0).max(1).default(1),
    /** Parser hint for unknown movements; the analyzer applies conservative defaults from it. */
    hintedPattern: z.enum(MOVEMENT_PATTERN_VALUES).nullable().default(null),
    /** Reps per round/set. Null when the part's repScheme applies or the unit is distance/cals/time. */
    reps: z.number().int().nonnegative().nullable().default(null),
    /** Per-movement rep scheme when movements differ ("10-9-8… pull-ups / 1-2-3… muscle-ups"). */
    repScheme: z.array(z.number().int().nonnegative()).nullable().default(null),
    calories: z.number().nonnegative().nullable().default(null),
    /** Second calorie prescription when written "15/12 cal". */
    caloriesAlt: z.number().nonnegative().nullable().default(null),
    distanceM: z.number().nonnegative().nullable().default(null),
    durationSec: z.number().nonnegative().nullable().default(null),
    heightCm: z.number().nonnegative().nullable().default(null),
    load: WodLoadSchema.nullable().default(null),
    /** Sets × reps when the movement carries its own scheme inside a strength part ("5×5"). */
    sets: z.number().int().positive().nullable().default(null),
    /** "each side", "alternating", "unbroken", "strict" … */
    modifiers: z.array(z.string().max(40)).default([]),
    /** Prescribed pace when the WOD says so ("easy row", "sprint"). Structure, not physiology. */
    pace: z.enum(["easy", "moderate", "hard"]).nullable().default(null),
  })
  .strict();
export type WodMovement = z.infer<typeof WodMovementSchema>;

export const WodPartSchema = z
  .object({
    kind: z.enum(WOD_PART_KIND_VALUES),
    format: z.enum(WOD_FORMAT_VALUES),
    title: z.string().max(120).nullable().default(null),
    /** Total prescribed duration (AMRAP / EMOM / intervals / not_timed estimate) in minutes. */
    durationMin: z.number().nonnegative().nullable().default(null),
    timeCapMin: z.number().nonnegative().nullable().default(null),
    rounds: z.number().int().positive().nullable().default(null),
    /** Shared rep scheme like 21-15-9 applied to every movement without its own reps. */
    repScheme: z.array(z.number().int().nonnegative()).nullable().default(null),
    /** EMOM / interval length in seconds (E2MOM → 120). */
    intervalSec: z.number().positive().nullable().default(null),
    /** Rest between rounds/intervals in seconds when prescribed. */
    restSec: z.number().nonnegative().nullable().default(null),
    /** EMOM/intervals where movements rotate across intervals ("min 1: row, min 2: burpees"). */
    alternating: z.boolean().default(false),
    /** Strength part scheme when uniform ("5×5"): sets and reps per set. */
    sets: z.number().int().positive().nullable().default(null),
    reps: z.number().int().positive().nullable().default(null),
    movements: z.array(WodMovementSchema).min(1),
    /** "alternating movements each minute", "rest as needed", … */
    notes: z.string().max(500).nullable().default(null),
  })
  .strict();
export type WodPart = z.infer<typeof WodPartSchema>;

export const NormalizedWodSchema = z
  .object({
    title: z.string().max(120).nullable().default(null),
    sourceText: z.string().max(8000),
    parts: z.array(WodPartSchema).min(1),
    /** Parser's own confidence 0..1 (how sure the structure is right). */
    parseConfidence: z.number().min(0).max(1),
    parser: z.enum(["AI_PARSED", "HEURISTIC", "USER"]),
    parserVersion: z.string().max(40),
    warnings: z.array(z.string().max(200)).default([]),
  })
  .strict();
export type NormalizedWod = z.infer<typeof NormalizedWodSchema>;

export const SCHEMA_VERSION = "normalized_wod_v1" as const;
