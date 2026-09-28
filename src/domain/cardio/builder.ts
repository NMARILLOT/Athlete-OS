import { z } from "zod";
import {
  CARDIO_KIND_VALUES,
  MODALITY_VALUES,
  type CardioKind,
  type IntensityBand,
  type LoadVector,
  type Modality,
  type PatternExposure,
  type SessionKind,
  type StimulusCredits,
} from "../core";
import { REFERENCE_LOAD } from "../athlete-model/defaults";
import { impactUnits } from "../load/impact";
import type { HrZoneSet } from "./zones";

/**
 * Cardio workout builder model (spec §80). A workout is a list of steps; each step targets an HR
 * zone / bpm / pace / power / cadence or is "open", and lasts a duration or a distance (neither =
 * "until lap button"). Repeats nest. Presets cover the engine's cardio candidate catalog.
 */
export const CARDIO_BUILDER_ALGORITHM_VERSION = "cardio_builder_v1" as const;

export const CARDIO_STEP_KIND_VALUES = [
  "warmup",
  "work",
  "recovery",
  "cooldown",
  "rest",
  "repeat",
] as const;
export type CardioStepKind = (typeof CARDIO_STEP_KIND_VALUES)[number];
export type CardioLeafKind = Exclude<CardioStepKind, "repeat">;

export const CARDIO_TARGET_TYPE_VALUES = [
  "hr_zone",
  "hr_bpm",
  "pace_sec_km",
  "power_w",
  "cadence",
  "open",
] as const;
export type CardioTargetType = (typeof CARDIO_TARGET_TYPE_VALUES)[number];

export interface CardioTarget {
  type: CardioTargetType;
  /** Required for `hr_zone`. */
  zone?: number;
  /** Lower bound in the target's unit (bpm, sec/km, W, spm). For pace, min = faster. */
  min?: number;
  max?: number;
}

export interface CardioRepeat {
  times: number;
  steps: CardioStep[];
}

export interface CardioStep {
  kind: CardioStepKind;
  durationSec?: number | null;
  distanceM?: number | null;
  target?: CardioTarget | null;
  /** Only for `kind = "repeat"`. */
  repeat?: CardioRepeat | null;
  notes?: string;
}

export const CardioTargetSchema = z
  .object({
    type: z.enum(CARDIO_TARGET_TYPE_VALUES),
    zone: z.number().int().min(1).max(5).optional(),
    min: z.number().nonnegative().optional(),
    max: z.number().nonnegative().optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.type === "hr_zone" && t.zone == null) {
      ctx.addIssue({ code: "custom", path: ["zone"], message: "hr_zone target requires a zone" });
    }
    if (t.min != null && t.max != null && t.min > t.max) {
      ctx.addIssue({ code: "custom", path: ["min"], message: "min must be ≤ max" });
    }
  });

/** Strict and recursive: a `repeat` step carries `repeat`, every other step must not. */
export const CardioStepSchema: z.ZodType<CardioStep> = z.lazy(() =>
  z
    .object({
      kind: z.enum(CARDIO_STEP_KIND_VALUES),
      durationSec: z.number().positive().nullable().optional(),
      distanceM: z.number().positive().nullable().optional(),
      target: CardioTargetSchema.nullable().optional(),
      repeat: z
        .object({
          times: z.number().int().min(1).max(100),
          steps: z.array(CardioStepSchema).min(1),
        })
        .strict()
        .nullable()
        .optional(),
      notes: z.string().max(300).optional(),
    })
    .strict()
    .superRefine((s, ctx) => {
      if (s.kind === "repeat" && !s.repeat) {
        ctx.addIssue({ code: "custom", path: ["repeat"], message: "repeat step requires repeat" });
      }
      if (s.kind !== "repeat" && s.repeat) {
        ctx.addIssue({
          code: "custom",
          path: ["repeat"],
          message: "only a repeat step may carry repeat",
        });
      }
    }),
);

export const CardioWorkoutSpecSchema = z
  .object({
    modality: z.enum(MODALITY_VALUES),
    kind: z.enum(CARDIO_KIND_VALUES),
    title: z.string().min(1).max(120),
    steps: z.array(CardioStepSchema).min(1),
  })
  .strict();

export interface CardioWorkoutSpec {
  modality: Modality;
  kind: CardioKind;
  title: string;
  steps: CardioStep[];
}

export type FlatCardioStep = Omit<CardioStep, "kind" | "repeat"> & { kind: CardioLeafKind };

/** Unrolls repeats (recursively) into the sequence the watch will actually execute. */
export function flattenSteps(steps: readonly CardioStep[]): FlatCardioStep[] {
  const out: FlatCardioStep[] = [];
  for (const step of steps) {
    if (step.kind === "repeat") {
      const times = step.repeat?.times ?? 0;
      const inner = step.repeat?.steps ?? [];
      for (let i = 0; i < times; i++) out.push(...flattenSteps(inner));
      continue;
    }
    const { repeat: _repeat, kind, ...leaf } = step;
    out.push({ ...leaf, kind });
  }
  return out;
}

/**
 * Default paces used to turn a distance step into minutes when no pace target is given
 * (sec per km). Running 5:30/km, bike 30 km/h, row 2:10/500 m, SkiErg 2:20/500 m,
 * swimming 2:00/100 m, walking 12:00/km, anything else 6:00/km.
 */
export const DEFAULT_PACE_SEC_KM: Record<Modality, number> = {
  running: 330,
  bike: 120,
  row: 260,
  ski: 280,
  swimming: 1200,
  walking: 720,
  strength: 360,
  gymnastics: 360,
  weightlifting: 360,
  mixed_modal: 360,
  mobility: 360,
  other: 360,
};

export interface DurationOptions {
  /** Pace used for distance steps without an explicit pace target (sec/km). */
  paceSecKmForDistance?: number;
}

function stepPaceSecKm(step: FlatCardioStep, fallback: number): number {
  const t = step.target;
  if (t?.type === "pace_sec_km") {
    if (t.min != null && t.max != null) return (t.min + t.max) / 2;
    if (t.min != null) return t.min;
    if (t.max != null) return t.max;
  }
  return fallback;
}

function stepSeconds(step: FlatCardioStep, fallbackPace: number): number {
  if (step.durationSec != null && step.durationSec > 0) return step.durationSec;
  if (step.distanceM != null && step.distanceM > 0)
    return (step.distanceM / 1000) * stepPaceSecKm(step, fallbackPace);
  return 0; // lap-button step: unknown, never invented
}

function stepKm(step: FlatCardioStep, fallbackPace: number): number {
  if (step.distanceM != null && step.distanceM > 0) return step.distanceM / 1000;
  if (step.durationSec != null && step.durationSec > 0)
    return step.durationSec / stepPaceSecKm(step, fallbackPace);
  return 0;
}

/** Total minutes (0.1 min), distance steps converted with the pace target, option or modality default. */
export function estimateDurationMin(
  spec: CardioWorkoutSpec,
  options: DurationOptions = {},
): number {
  const pace = options.paceSecKmForDistance ?? DEFAULT_PACE_SEC_KM[spec.modality];
  const total = flattenSteps(spec.steps).reduce((acc, s) => acc + stepSeconds(s, pace), 0);
  return Math.round((total / 60) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Expected load profile (ENGINE.md §1 LoadProfile shape)
// ---------------------------------------------------------------------------

/** Structurally identical to the engine's `LoadProfile` (kept here so cardio never imports engine). */
export interface CardioLoadProfile {
  expectedCredits: StimulusCredits;
  loadVector: LoadVector;
  intensity: IntensityBand;
  heavyStrength: boolean;
  durationMin: number;
  modality: Modality;
  patterns: PatternExposure;
  impactUnits: number;
}

const HARD_KINDS: readonly CardioKind[] = ["threshold", "vo2max", "intervals", "test"];
const MODERATE_KINDS: readonly CardioKind[] = ["tempo", "fartlek", "hills"];
const BAND_RANK: Record<IntensityBand, number> = { easy: 0, moderate: 1, hard: 2 };

function kindBand(kind: CardioKind): IntensityBand {
  if (HARD_KINDS.includes(kind)) return "hard";
  if (MODERATE_KINDS.includes(kind)) return "moderate";
  return "easy";
}

function stepZone(step: FlatCardioStep): number | null {
  return step.target?.type === "hr_zone" ? (step.target.zone ?? null) : null;
}

/** Work steps: Z4+ hard, Z3 moderate, Z1–2 easy, no HR zone → the session kind's band. Other steps are easy. */
function stepBand(step: FlatCardioStep, fallback: IntensityBand): IntensityBand {
  if (step.kind !== "work") return "easy";
  const zone = stepZone(step);
  if (zone == null) return fallback;
  if (zone >= 4) return "hard";
  if (zone === 3) return "moderate";
  return "easy";
}

const lv = (
  cardiovascular: number,
  muscular_lower: number,
  muscular_upper: number,
  impact: number,
  eccentric: number,
  technical: number,
): LoadVector => ({ cardiovascular, muscular_lower, muscular_upper, impact, eccentric, technical });

type LoadClass = "easy" | "moderate" | "threshold" | "vo2";
type LoadModality = "running" | "bike" | "row" | "ski" | "walking" | "swimming" | "other";

/**
 * Reference single-session load vectors (0..10 per dimension) — REFERENCE_LOAD where an entry exists,
 * catalog-consistent values otherwise. "easy" is a 60-min session and is scaled by duration.
 */
const BASE_LOAD: Record<LoadModality, Record<LoadClass, LoadVector>> = {
  running: {
    easy: REFERENCE_LOAD.z2_run_60 ?? lv(3, 3, 0, 5, 2, 0),
    moderate: lv(6, 4, 0, 5, 2.5, 0.5),
    threshold: lv(8, 5, 0, 6, 3, 1),
    vo2: REFERENCE_LOAD.vo2_run ?? lv(9, 5, 0, 7, 4, 1),
  },
  bike: {
    easy: REFERENCE_LOAD.z2_bike_60 ?? lv(3, 3, 0, 0, 0, 0),
    moderate: lv(6, 4, 0, 0, 0, 0),
    threshold: REFERENCE_LOAD.threshold_bike ?? lv(8, 5, 0, 0, 0, 0),
    vo2: lv(9, 5, 0, 0, 0, 0),
  },
  row: {
    easy: lv(3, 2, 2, 0, 0, 0.5),
    moderate: lv(6, 3, 3, 0, 0.5, 0.5),
    threshold: lv(8, 4, 4, 0, 0, 1),
    vo2: lv(9, 4, 4, 0, 0, 1),
  },
  ski: {
    easy: lv(3, 1, 3, 0, 0, 0.5),
    moderate: lv(6, 2, 4, 0, 0.5, 0.5),
    threshold: lv(8, 3, 5, 0, 0.5, 1),
    vo2: lv(9, 3, 5, 0, 0.5, 1),
  },
  walking: {
    easy: lv(1.5, 1, 0, 1.5, 0, 0),
    moderate: lv(3, 2, 0, 2, 0.5, 0),
    threshold: lv(4, 3, 0, 3, 1, 0),
    vo2: lv(4, 3, 0, 3, 1, 0),
  },
  swimming: {
    easy: lv(3, 1, 3, 0, 0, 1),
    moderate: lv(6, 2, 4, 0, 0, 1),
    threshold: lv(8, 3, 5, 0, 0, 1),
    vo2: lv(9, 3, 5, 0, 0, 1),
  },
  other: {
    easy: lv(3, 2, 2, 1, 0.5, 0.5),
    moderate: lv(6, 3, 3, 2, 1, 1),
    threshold: lv(8, 4, 4, 2, 1, 1),
    vo2: lv(9, 4, 4, 2, 1, 1),
  },
};

function loadModality(m: Modality): LoadModality {
  switch (m) {
    case "running":
    case "bike":
    case "row":
    case "ski":
    case "walking":
    case "swimming":
      return m;
    default:
      return "other";
  }
}

const EASY_SCALE = { refMinutes: 60, min: 0.6, max: 1.4 } as const;
/** A "recovery" session is deliberately lighter than a Z2 session of the same length. */
const RECOVERY_LOAD_FACTOR = 0.6;

const round1 = (x: number): number => Math.round(x * 10) / 10;
const round2 = (x: number): number => Math.round(x * 100) / 100;

function scaleVector(v: LoadVector, factor: number): LoadVector {
  return lv(
    round1(Math.min(10, v.cardiovascular * factor)),
    round1(Math.min(10, v.muscular_lower * factor)),
    round1(Math.min(10, v.muscular_upper * factor)),
    round1(Math.min(10, v.impact * factor)),
    round1(Math.min(10, v.eccentric * factor)),
    round1(Math.min(10, v.technical * factor)),
  );
}

interface MinutesByBand {
  easy: number;
  moderate: number;
  hard: number;
}

/**
 * Expected credits, documented rules:
 *  - easy session: aerobic_easy = min(1, easyMin/45); aerobic_long = min(1, min/90) when ≥ 75 easy min.
 *    Walking counts 30 % of aerobic_easy, a "recovery" kind 50 %; both add mobility_recovery.
 *  - threshold → threshold 1; vo2max → vo2max 1.
 *  - intervals → vo2max 1 when the hardest work step is Z5 (or has no HR zone), else threshold 1.
 *  - test → vo2max 0.7 (+ threshold 0.5 when the effort lasts more than 10 min, e.g. a 5 km).
 *  - tempo / fartlek / Z3–Z4 work in any other kind → threshold = min(1, qualityMin/20).
 *  - hills → power 0.5 on top; strides → power 0.3.
 */
function expectedCredits(
  spec: CardioWorkoutSpec,
  intensity: IntensityBand,
  minutes: number,
  byBand: MinutesByBand,
  maxWorkZone: number | null,
): StimulusCredits {
  const credits: StimulusCredits = {};
  const qualityMin = byBand.moderate + byBand.hard;
  const qualityCredit = (): void => {
    if (qualityMin > 0) credits.threshold = round2(Math.min(1, qualityMin / 20));
  };

  if (intensity === "easy") {
    const factor = spec.modality === "walking" ? 0.3 : spec.kind === "recovery" ? 0.5 : 1;
    credits.aerobic_easy = round2(Math.min(1, byBand.easy / 45) * factor);
    if (byBand.easy >= 75) credits.aerobic_long = round2(Math.min(1, minutes / 90));
  }
  if (spec.kind === "recovery" || spec.modality === "walking") credits.mobility_recovery = 0.7;

  switch (spec.kind) {
    case "threshold":
      credits.threshold = 1;
      break;
    case "vo2max":
      credits.vo2max = 1;
      break;
    case "intervals":
      if (maxWorkZone == null || maxWorkZone >= 5) credits.vo2max = 1;
      else credits.threshold = 1;
      break;
    case "test":
      credits.vo2max = 0.7;
      if (byBand.hard > 10) credits.threshold = 0.5;
      break;
    case "strides":
      credits.power = 0.3;
      break;
    case "hills":
      credits.power = 0.5;
      qualityCredit();
      break;
    default:
      qualityCredit();
  }
  return credits;
}

/**
 * Deterministic expected load of a planned cardio workout, in the engine's LoadProfile shape.
 * Intensity: hard when any work step targets Z4+ or the kind is threshold/vo2max/intervals/test;
 * moderate for tempo/fartlek/hills or Z3 work; easy otherwise. Load vectors follow REFERENCE_LOAD
 * (easy sessions scaled by sqrt(min/60), clamped 0.6..1.4). Impact units = estimated running km
 * (walking km × 0.25); 0 for non-impact modalities. Patterns: locomotion = min/15 (+ pull for ergs).
 */
export function expectedLoadProfile(
  spec: CardioWorkoutSpec,
  options: DurationOptions = {},
): CardioLoadProfile {
  const fallbackBand = kindBand(spec.kind);
  const pace = options.paceSecKmForDistance ?? DEFAULT_PACE_SEC_KM[spec.modality];
  const flat = flattenSteps(spec.steps);

  const byBand: MinutesByBand = { easy: 0, moderate: 0, hard: 0 };
  let intensity: IntensityBand = fallbackBand;
  let maxWorkZone: number | null = null;
  let km = 0;
  for (const step of flat) {
    const band = stepBand(step, fallbackBand);
    byBand[band] += stepSeconds(step, pace) / 60;
    if (BAND_RANK[band] > BAND_RANK[intensity]) intensity = band;
    const zone = step.kind === "work" ? stepZone(step) : null;
    if (zone != null && (maxWorkZone == null || zone > maxWorkZone)) maxWorkZone = zone;
    km += stepKm(step, pace);
  }
  const minutes = round1(byBand.easy + byBand.moderate + byBand.hard);

  const loadClass: LoadClass =
    intensity === "hard"
      ? spec.kind === "vo2max" || (maxWorkZone ?? 5) >= 5
        ? "vo2"
        : "threshold"
      : intensity;
  const base = BASE_LOAD[loadModality(spec.modality)][loadClass];
  let factor = 1;
  if (intensity === "easy") {
    factor = Math.min(
      EASY_SCALE.max,
      Math.max(EASY_SCALE.min, Math.sqrt(minutes / EASY_SCALE.refMinutes)),
    );
    if (spec.kind === "recovery") factor *= RECOVERY_LOAD_FACTOR;
  }

  const iu =
    spec.modality === "running"
      ? impactUnits({ runKm: km })
      : spec.modality === "walking"
        ? impactUnits({ walkKm: km })
        : 0;

  const patterns: PatternExposure = { locomotion: round2(minutes / 15) };
  if (spec.modality === "row") patterns.horizontal_pull = round2(minutes / 30);
  if (spec.modality === "ski") patterns.vertical_pull = round2(minutes / 30);

  return {
    expectedCredits: expectedCredits(spec, intensity, minutes, byBand, maxWorkZone),
    loadVector: scaleVector(base, factor),
    intensity,
    heavyStrength: false,
    durationMin: minutes,
    modality: spec.modality,
    patterns,
    impactUnits: iu,
  };
}

// ---------------------------------------------------------------------------
// Presets (engine candidate catalog, ENGINE.md §3)
// ---------------------------------------------------------------------------

export const CARDIO_PRESET_KINDS = [
  "run_easy_45",
  "run_easy_60",
  "run_long_90",
  "run_tempo",
  "run_threshold",
  "run_vo2",
  "strides",
  "bike_easy_60",
  "bike_long_120",
  "bike_intervals",
  "row_easy_30",
  "row_intervals",
  "ski_easy_30",
  "walk_45",
  "recovery_spin_30",
  "test_run_5k",
  "test_row_2k",
] as const satisfies readonly SessionKind[];
export type CardioPresetKind = (typeof CARDIO_PRESET_KINDS)[number];

const min = (m: number): number => m * 60;
const zone = (z: 1 | 2 | 3 | 4 | 5): CardioTarget => ({ type: "hr_zone", zone: z });
const OPEN: CardioTarget = { type: "open" };
const timed = (
  kind: CardioLeafKind,
  durationSec: number,
  target: CardioTarget,
  notes?: string,
): CardioStep => (notes ? { kind, durationSec, target, notes } : { kind, durationSec, target });
const dist = (
  kind: CardioLeafKind,
  distanceM: number,
  target: CardioTarget,
  notes?: string,
): CardioStep => (notes ? { kind, distanceM, target, notes } : { kind, distanceM, target });
const repeat = (times: number, steps: CardioStep[]): CardioStep => ({
  kind: "repeat",
  repeat: { times, steps },
});

export const CARDIO_PRESETS: Record<CardioPresetKind, CardioWorkoutSpec> = {
  run_easy_45: {
    modality: "running",
    kind: "zone2",
    title: "Footing Z2 — 45 min",
    steps: [timed("work", min(45), zone(2))],
  },
  run_easy_60: {
    modality: "running",
    kind: "zone2",
    title: "Footing Z2 — 60 min",
    steps: [timed("work", min(60), zone(2))],
  },
  run_long_90: {
    modality: "running",
    kind: "long",
    title: "Sortie longue — 90 min",
    steps: [timed("work", min(90), zone(2))],
  },
  run_tempo: {
    modality: "running",
    kind: "tempo",
    title: "Tempo — 20 min",
    steps: [
      timed("warmup", min(10), zone(1)),
      timed("work", min(20), zone(3)),
      timed("cooldown", min(10), zone(1)),
    ],
  },
  run_threshold: {
    modality: "running",
    kind: "threshold",
    title: "Seuil — 3 × 8 min",
    steps: [
      timed("warmup", min(10), zone(1)),
      repeat(3, [
        timed("work", min(8), zone(4)),
        timed("recovery", min(2), zone(1), "trot facile"),
      ]),
      timed("cooldown", min(10), zone(1)),
    ],
  },
  run_vo2: {
    modality: "running",
    kind: "vo2max",
    title: "VO2max — 5 × 3 min",
    steps: [
      timed("warmup", min(10), zone(1)),
      repeat(5, [
        timed("work", min(3), zone(5)),
        timed("recovery", min(3), zone(1), "trot facile"),
      ]),
      timed("cooldown", min(10), zone(1)),
    ],
  },
  strides: {
    modality: "running",
    kind: "strides",
    title: "Footing + 6 lignes droites",
    steps: [
      timed("work", min(30), zone(2)),
      repeat(6, [
        timed("work", 20, OPEN, "rapide et relâché"),
        timed("recovery", 60, zone(1), "marche"),
      ]),
    ],
  },
  bike_easy_60: {
    modality: "bike",
    kind: "zone2",
    title: "Vélo Z2 — 60 min",
    steps: [timed("work", min(60), zone(2))],
  },
  bike_long_120: {
    modality: "bike",
    kind: "long",
    title: "Vélo long — 120 min",
    steps: [timed("work", min(120), zone(2))],
  },
  bike_intervals: {
    modality: "bike",
    kind: "intervals",
    title: "Vélo seuil — 4 × 8 min",
    steps: [
      timed("warmup", min(10), zone(1)),
      repeat(4, [timed("work", min(8), zone(4)), timed("recovery", min(4), zone(1))]),
      timed("cooldown", min(10), zone(1)),
    ],
  },
  row_easy_30: {
    modality: "row",
    kind: "zone2",
    title: "Rameur facile — 30 min",
    steps: [timed("work", min(30), zone(2))],
  },
  row_intervals: {
    modality: "row",
    kind: "intervals",
    title: "Rameur — 5 × 4 min",
    steps: [
      timed("warmup", min(5), zone(1)),
      repeat(5, [timed("work", min(4), zone(4)), timed("recovery", min(2), zone(1))]),
      timed("cooldown", min(5), zone(1)),
    ],
  },
  ski_easy_30: {
    modality: "ski",
    kind: "zone2",
    title: "SkiErg facile — 30 min",
    steps: [timed("work", min(30), zone(2))],
  },
  walk_45: {
    modality: "walking",
    kind: "recovery",
    title: "Marche — 45 min",
    steps: [timed("work", min(45), zone(1))],
  },
  recovery_spin_30: {
    modality: "bike",
    kind: "recovery",
    title: "Vélo récup — 30 min",
    steps: [timed("work", min(30), zone(1))],
  },
  test_run_5k: {
    modality: "running",
    kind: "test",
    title: "Test 5 km",
    steps: [
      timed("warmup", min(10), zone(1)),
      dist("work", 5000, OPEN, "à fond, régulier"),
      timed("cooldown", min(10), zone(1)),
    ],
  },
  test_row_2k: {
    modality: "row",
    kind: "test",
    title: "Test 2 km rameur",
    steps: [
      timed("warmup", min(10), zone(1)),
      dist("work", 2000, OPEN, "à fond"),
      timed("cooldown", min(5), zone(1)),
    ],
  },
};

// ---------------------------------------------------------------------------
// Provider-neutral workout draft
// ---------------------------------------------------------------------------

export type DraftSport =
  "running" | "cycling" | "rowing" | "ski_erg" | "swimming" | "walking" | "other";
export type DraftStepType = "warmup" | "interval" | "recovery" | "cooldown" | "rest" | "repeat";
export type DraftDurationType = "time" | "distance" | "lap_button" | "iterations";
export type DraftTargetType =
  "heart_rate_zone" | "heart_rate" | "pace" | "power" | "cadence" | "open";

export interface GarminDraftStep {
  stepType: DraftStepType;
  durationType: DraftDurationType;
  /** Seconds, metres or iterations depending on `durationType`; null for lap button. */
  durationValue: number | null;
  targetType: DraftTargetType;
  /** Domain units: bpm, sec/km (low = faster), W, spm; for `heart_rate_zone` both hold the zone number. */
  targetValueLow: number | null;
  targetValueHigh: number | null;
  repeatCount?: number;
  steps?: GarminDraftStep[];
  notes?: string;
}

export interface GarminWorkoutDraft {
  name: string;
  sport: DraftSport;
  steps: GarminDraftStep[];
}

const DRAFT_SPORT: Record<Modality, DraftSport> = {
  running: "running",
  bike: "cycling",
  row: "rowing",
  ski: "ski_erg",
  swimming: "swimming",
  walking: "walking",
  strength: "other",
  gymnastics: "other",
  weightlifting: "other",
  mixed_modal: "other",
  mobility: "other",
  other: "other",
};

const DRAFT_STEP_TYPE: Record<CardioStepKind, DraftStepType> = {
  warmup: "warmup",
  work: "interval",
  recovery: "recovery",
  cooldown: "cooldown",
  rest: "rest",
  repeat: "repeat",
};

function draftTarget(
  target: CardioTarget | null | undefined,
  zoneSet?: HrZoneSet | null,
): Pick<GarminDraftStep, "targetType" | "targetValueLow" | "targetValueHigh"> {
  if (!target || target.type === "open")
    return { targetType: "open", targetValueLow: null, targetValueHigh: null };
  if (target.type === "hr_zone") {
    const z = target.zone ?? null;
    const band = zoneSet && z != null ? zoneSet.zones.find((x) => x.zone === z) : undefined;
    if (band)
      return {
        targetType: "heart_rate",
        targetValueLow: band.minBpm,
        targetValueHigh: band.maxBpm,
      };
    return { targetType: "heart_rate_zone", targetValueLow: z, targetValueHigh: z };
  }
  const targetType: DraftTargetType =
    target.type === "hr_bpm"
      ? "heart_rate"
      : target.type === "pace_sec_km"
        ? "pace"
        : target.type === "power_w"
          ? "power"
          : "cadence";
  return { targetType, targetValueLow: target.min ?? null, targetValueHigh: target.max ?? null };
}

function draftStep(step: CardioStep, zoneSet?: HrZoneSet | null): GarminDraftStep {
  if (step.kind === "repeat") {
    const times = step.repeat?.times ?? 1;
    return {
      stepType: "repeat",
      durationType: "iterations",
      durationValue: times,
      targetType: "open",
      targetValueLow: null,
      targetValueHigh: null,
      repeatCount: times,
      steps: (step.repeat?.steps ?? []).map((s) => draftStep(s, zoneSet)),
    };
  }
  const duration: Pick<GarminDraftStep, "durationType" | "durationValue"> =
    step.durationSec != null && step.durationSec > 0
      ? { durationType: "time", durationValue: step.durationSec }
      : step.distanceM != null && step.distanceM > 0
        ? { durationType: "distance", durationValue: step.distanceM }
        : { durationType: "lap_button", durationValue: null };
  const out: GarminDraftStep = {
    stepType: DRAFT_STEP_TYPE[step.kind],
    ...duration,
    ...draftTarget(step.target, zoneSet),
  };
  if (step.notes) out.notes = step.notes;
  return out;
}

/**
 * Provider-neutral intermediate for "SEND TO GARMIN" (spec §80–81). This is NOT the Garmin
 * Training API payload: no endpoint or field of that API is assumed here. The official provider
 * (server/providers/garmin) maps this draft to whatever the API expects, converting units
 * (sec/km → m/s, …). When a versioned `zoneSet` is given, HR-zone targets are resolved to explicit
 * bpm bounds so the watch follows OUR zones, not the device's own.
 */
export function toGarminWorkoutDraft(
  spec: CardioWorkoutSpec,
  zoneSet?: HrZoneSet | null,
): GarminWorkoutDraft {
  return {
    name: spec.title,
    sport: DRAFT_SPORT[spec.modality],
    steps: spec.steps.map((s) => draftStep(s, zoneSet)),
  };
}
