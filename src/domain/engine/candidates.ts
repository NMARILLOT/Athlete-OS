import type {
  Equipment,
  IntensityBand,
  LoadVector,
  Modality,
  PatternExposure,
  StimulusCredits,
  UserIntent,
} from "../core";
import {
  CROSSFIT_CLASS_PRIOR_CONFIDENCE,
  CROSSFIT_CLASS_PRIOR_CREDITS,
  REFERENCE_LOAD,
} from "../athlete-model/defaults";
import type { Candidate, LoadProfile, PlannedSession } from "./types";

const lv = (
  cardiovascular: number,
  muscular_lower: number,
  muscular_upper: number,
  impact: number,
  eccentric: number,
  technical: number,
): LoadVector => ({ cardiovascular, muscular_lower, muscular_upper, impact, eccentric, technical });

interface CatalogEntry {
  kind: string;
  family: string;
  title: string;
  durationMin: number;
  intensity: IntensityBand;
  heavyStrength?: boolean;
  modality: Modality;
  loadVector: LoadVector;
  expectedCredits: StimulusCredits;
  patterns: PatternExposure;
  impactUnits?: number;
  equipment: Equipment[];
  recovery?: boolean;
  isTest?: boolean;
  testKey?: string;
  templateId?: string;
  intentOnly?: boolean;
}

/**
 * Candidate catalog (ENGINE.md §3). Load vectors follow REFERENCE_LOAD; credits are the standard
 * exposure each session provides. `intentOnly` families are generated only when an intent asks.
 */
export const CANDIDATE_CATALOG: readonly CatalogEntry[] = [
  // Strength
  {
    kind: "strength_lower",
    family: "strength_lower",
    title: "Strength — Lower",
    durationMin: 60,
    intensity: "moderate",
    heavyStrength: true,
    modality: "strength",
    loadVector: REFERENCE_LOAD.heavy_squat_5x5 ?? lv(2, 8, 2, 0, 7, 4),
    expectedCredits: { strength_lower: 1, hypertrophy: 0.5 },
    patterns: { squat: 3, hinge: 2 },
    equipment: ["barbell", "rack"],
    templateId: "lower_a",
  },
  {
    kind: "strength_upper",
    family: "strength_upper",
    title: "Strength — Upper",
    durationMin: 60,
    intensity: "moderate",
    heavyStrength: true,
    modality: "strength",
    loadVector: REFERENCE_LOAD.heavy_upper ?? lv(2, 0.5, 8, 0, 4, 2),
    expectedCredits: { strength_upper: 1, hypertrophy: 0.5 },
    patterns: { horizontal_push: 2, vertical_push: 1.5, horizontal_pull: 2, vertical_pull: 1.5 },
    equipment: ["barbell", "bench", "pull_up_bar"],
    templateId: "upper_a",
  },
  {
    kind: "strength_full",
    family: "strength_full",
    title: "Strength — Full body",
    durationMin: 60,
    intensity: "moderate",
    heavyStrength: true,
    modality: "strength",
    loadVector: lv(2, 6, 6, 0, 5, 3),
    expectedCredits: { strength_lower: 0.7, strength_upper: 0.7 },
    patterns: { squat: 2, hinge: 1.5, horizontal_push: 1.5, vertical_pull: 1.5 },
    equipment: ["barbell", "rack", "bench", "pull_up_bar"],
    templateId: "full_a",
  },
  {
    kind: "accessory_upper",
    family: "accessory",
    title: "Accessoires haut du corps",
    durationMin: 40,
    intensity: "easy",
    modality: "strength",
    loadVector: lv(1, 0, 5, 0, 3, 1),
    expectedCredits: { hypertrophy: 0.7, strength_upper: 0.3 },
    patterns: { horizontal_pull: 1.5, vertical_push: 1, isolation: 2 },
    equipment: ["dumbbell"],
    templateId: "accessory_upper_a",
  },
  {
    kind: "olympic_technique",
    family: "olympic",
    title: "Technique haltéro",
    durationMin: 45,
    intensity: "moderate",
    modality: "weightlifting",
    loadVector: lv(2, 4, 3, 1, 2, 8),
    expectedCredits: { olympic_technique: 1, power: 0.5 },
    patterns: { olympic_lift: 3, hinge: 1, squat: 1 },
    equipment: ["barbell"],
    templateId: "olympic_technique_a",
  },
  {
    kind: "gymnastics_skill",
    family: "gymnastics",
    title: "Skill gymnastique",
    durationMin: 40,
    intensity: "easy",
    modality: "gymnastics",
    loadVector: lv(2, 0.5, 4, 0, 2, 6),
    expectedCredits: { gymnastics_skill: 1 },
    patterns: { gymnastics: 2, vertical_pull: 1.5, vertical_push: 1.5, rotation_core: 1 },
    equipment: ["pull_up_bar"],
    templateId: "gymnastics_skill_a",
  },
  // Easy endurance
  {
    kind: "run_easy_45",
    family: "run_easy",
    title: "Run — Zone 2 — 45 min",
    durationMin: 45,
    intensity: "easy",
    modality: "running",
    loadVector: lv(2.5, 2, 0, 4, 1.5, 0),
    expectedCredits: { aerobic_easy: 1 },
    patterns: { locomotion: 3 },
    impactUnits: 8,
    equipment: ["outdoor"],
  },
  {
    kind: "run_easy_60",
    family: "run_easy",
    title: "Run — Zone 2 — 60 min",
    durationMin: 60,
    intensity: "easy",
    modality: "running",
    loadVector: REFERENCE_LOAD.z2_run_60 ?? lv(3, 2.5, 0, 5, 2, 0),
    expectedCredits: { aerobic_easy: 1.2 },
    patterns: { locomotion: 4 },
    impactUnits: 10.5,
    equipment: ["outdoor"],
  },
  {
    kind: "run_long_90",
    family: "run_long",
    title: "Sortie longue — 90 min",
    durationMin: 90,
    intensity: "easy",
    modality: "running",
    loadVector: lv(4.5, 4, 0, 7, 3.5, 0),
    expectedCredits: { aerobic_easy: 1, aerobic_long: 1 },
    patterns: { locomotion: 6 },
    impactUnits: 15,
    equipment: ["outdoor"],
  },
  {
    kind: "bike_easy_60",
    family: "bike_easy",
    title: "Vélo — Zone 2 — 60 min",
    durationMin: 60,
    intensity: "easy",
    modality: "bike",
    loadVector: REFERENCE_LOAD.z2_bike_60 ?? lv(3, 2, 0, 0, 0, 0),
    expectedCredits: { aerobic_easy: 1.2 },
    patterns: { locomotion: 4 },
    impactUnits: 0,
    equipment: ["bike_erg", "road_bike"],
  },
  {
    kind: "bike_long_120",
    family: "bike_long",
    title: "Vélo long — 120 min",
    durationMin: 120,
    intensity: "easy",
    modality: "bike",
    loadVector: lv(5, 3.5, 0, 0, 0.5, 0),
    expectedCredits: { aerobic_easy: 1, aerobic_long: 1 },
    patterns: { locomotion: 8 },
    impactUnits: 0,
    equipment: ["road_bike", "bike_erg"],
  },
  {
    kind: "row_easy_30",
    family: "row",
    title: "Rameur facile — 30 min",
    durationMin: 30,
    intensity: "easy",
    modality: "row",
    loadVector: lv(2, 1.5, 1.5, 0, 0, 0.5),
    expectedCredits: { aerobic_easy: 0.7 },
    patterns: { locomotion: 2, horizontal_pull: 1 },
    impactUnits: 0,
    equipment: ["rower"],
  },
  {
    kind: "ski_easy_30",
    family: "ski",
    title: "SkiErg facile — 30 min",
    durationMin: 30,
    intensity: "easy",
    modality: "ski",
    loadVector: lv(2, 0.5, 2, 0, 0, 0.5),
    expectedCredits: { aerobic_easy: 0.7 },
    patterns: { locomotion: 2, vertical_pull: 1 },
    impactUnits: 0,
    equipment: ["ski_erg"],
  },
  {
    kind: "walk_45",
    family: "walk",
    title: "Marche — 45 min",
    durationMin: 45,
    intensity: "easy",
    modality: "walking",
    loadVector: lv(1, 0.5, 0, 1, 0, 0),
    expectedCredits: { mobility_recovery: 0.5, aerobic_easy: 0.3 },
    patterns: { locomotion: 1 },
    impactUnits: 2,
    equipment: ["outdoor"],
    recovery: true,
  },
  // Hard endurance
  {
    kind: "run_tempo",
    family: "run_hard",
    title: "Run — Tempo — 45 min",
    durationMin: 45,
    intensity: "moderate",
    modality: "running",
    loadVector: lv(6, 4, 0, 5, 2.5, 0.5),
    expectedCredits: { threshold: 0.6, aerobic_easy: 0.3 },
    patterns: { locomotion: 3 },
    impactUnits: 8,
    equipment: ["outdoor"],
  },
  {
    kind: "run_threshold",
    family: "run_hard",
    title: "Run — Seuil — 3×8 min",
    durationMin: 55,
    intensity: "hard",
    modality: "running",
    loadVector: lv(8, 5, 0, 6, 3, 1),
    expectedCredits: { threshold: 1 },
    patterns: { locomotion: 4 },
    impactUnits: 9,
    equipment: ["outdoor"],
  },
  {
    kind: "run_vo2",
    family: "run_hard",
    title: "Run — VO2max — 5×3 min",
    durationMin: 50,
    intensity: "hard",
    modality: "running",
    loadVector: REFERENCE_LOAD.vo2_run ?? lv(9, 5, 0, 7, 4, 1),
    expectedCredits: { vo2max: 1 },
    patterns: { locomotion: 4 },
    impactUnits: 8,
    equipment: ["outdoor", "track"],
  },
  {
    kind: "strides",
    family: "run_easy",
    title: "Run facile + strides",
    durationMin: 40,
    intensity: "easy",
    modality: "running",
    loadVector: lv(3, 3, 0, 4.5, 2, 1),
    expectedCredits: { aerobic_easy: 0.8, power: 0.3 },
    patterns: { locomotion: 3 },
    impactUnits: 7,
    equipment: ["outdoor"],
  },
  {
    kind: "bike_intervals",
    family: "bike_hard",
    title: "Vélo — Intervalles seuil — 4×8 min",
    durationMin: 60,
    intensity: "hard",
    modality: "bike",
    loadVector: REFERENCE_LOAD.threshold_bike ?? lv(8, 5, 0, 0, 0, 0),
    expectedCredits: { threshold: 1 },
    patterns: { locomotion: 4 },
    impactUnits: 0,
    equipment: ["bike_erg", "road_bike"],
  },
  {
    kind: "row_intervals",
    family: "row",
    title: "Rameur — Intervalles — 5×4 min",
    durationMin: 40,
    intensity: "hard",
    modality: "row",
    loadVector: lv(8, 4, 4, 0, 0, 1),
    expectedCredits: { threshold: 1 },
    patterns: { locomotion: 3, horizontal_pull: 1.5 },
    impactUnits: 0,
    equipment: ["rower"],
  },
  // Recovery
  {
    kind: "mobility_20",
    family: "mobility",
    title: "Mobilité — 20 min",
    durationMin: 20,
    intensity: "easy",
    modality: "mobility",
    loadVector: REFERENCE_LOAD.mobility ?? lv(0.5, 0.5, 0.5, 0, 0, 0),
    expectedCredits: { mobility_recovery: 1 },
    patterns: {},
    impactUnits: 0,
    equipment: ["bodyweight"],
    recovery: true,
  },
  {
    kind: "recovery_spin_30",
    family: "recovery_spin",
    title: "Vélo récup — 30 min",
    durationMin: 30,
    intensity: "easy",
    modality: "bike",
    loadVector: lv(1.5, 1, 0, 0, 0, 0),
    expectedCredits: { mobility_recovery: 0.7, aerobic_easy: 0.3 },
    patterns: { locomotion: 1 },
    impactUnits: 0,
    equipment: ["bike_erg", "road_bike"],
    recovery: true,
  },
  {
    kind: "rest",
    family: "rest",
    title: "Repos",
    durationMin: 0,
    intensity: "easy",
    modality: "other",
    loadVector: lv(0, 0, 0, 0, 0, 0),
    expectedCredits: {},
    patterns: {},
    impactUnits: 0,
    equipment: [],
    recovery: true,
  },
  // Tests
  {
    kind: "test_run_5k",
    family: "test",
    title: "Test 5 km",
    durationMin: 40,
    intensity: "hard",
    modality: "running",
    loadVector: lv(9, 5, 0, 6, 3, 0),
    expectedCredits: { vo2max: 0.7, threshold: 0.5 },
    patterns: { locomotion: 3 },
    impactUnits: 6,
    equipment: ["outdoor", "track"],
    isTest: true,
    testKey: "run_5k",
  },
  {
    kind: "test_row_2k",
    family: "test",
    title: "Test 2 km rameur",
    durationMin: 25,
    intensity: "hard",
    modality: "row",
    loadVector: lv(9, 4, 4, 0, 0, 1),
    expectedCredits: { vo2max: 0.7 },
    patterns: { locomotion: 2, horizontal_pull: 1 },
    impactUnits: 0,
    equipment: ["rower"],
    isTest: true,
    testKey: "row_2k",
  },
  // Intent families (composite)
  {
    kind: "partner_wod_fun",
    family: "partner",
    title: "WOD partner — 30 min",
    durationMin: 30,
    intensity: "hard",
    modality: "mixed_modal",
    loadVector: lv(7, 5, 5, 3, 3, 2),
    expectedCredits: { crossfit_exposure: 0.5, hi_conditioning: 1 },
    patterns: { squat: 1.5, horizontal_push: 1, locomotion: 1.5 },
    impactUnits: 3,
    equipment: ["barbell", "rower"],
    intentOnly: true,
  },
  {
    kind: "partner_wod_easy",
    family: "partner",
    title: "WOD partner cool — 25 min",
    durationMin: 25,
    intensity: "moderate",
    modality: "mixed_modal",
    loadVector: lv(5, 3, 3, 2, 2, 1),
    expectedCredits: { crossfit_exposure: 0.4, hi_conditioning: 0.4, aerobic_easy: 0.3 },
    patterns: { squat: 1, locomotion: 1 },
    impactUnits: 2,
    equipment: ["rower"],
    intentOnly: true,
  },
  {
    kind: "benchmark_attempt",
    family: "benchmark",
    title: "Benchmark",
    durationMin: 25,
    intensity: "hard",
    modality: "mixed_modal",
    loadVector: lv(8, 6, 6, 2, 4, 3),
    expectedCredits: { hi_conditioning: 1, crossfit_exposure: 0.5 },
    patterns: { squat: 2, vertical_pull: 1.5, vertical_push: 1.5 },
    impactUnits: 2,
    equipment: ["barbell", "pull_up_bar"],
    intentOnly: true,
    isTest: true,
    testKey: "benchmark",
  },
  {
    kind: "hyrox_easy",
    family: "hyrox",
    title: "Hyrox esprit facile — 45 min run + SkiErg technique",
    durationMin: 60,
    intensity: "easy",
    modality: "mixed_modal",
    loadVector: lv(3, 3, 2, 4, 1.5, 1),
    expectedCredits: { aerobic_easy: 1 },
    patterns: { locomotion: 3, vertical_pull: 1 },
    impactUnits: 8,
    equipment: ["outdoor", "ski_erg"],
    intentOnly: true,
  },
  {
    kind: "hyrox_moderate",
    family: "hyrox",
    title: "Hyrox tempo — 60 min",
    durationMin: 60,
    intensity: "moderate",
    modality: "mixed_modal",
    loadVector: lv(6, 5, 4, 5, 3, 1),
    expectedCredits: { threshold: 0.5, hi_conditioning: 0.5, aerobic_easy: 0.3 },
    patterns: { locomotion: 3, squat: 1.5, carry: 1 },
    impactUnits: 8,
    equipment: ["outdoor", "ski_erg", "sled"],
    intentOnly: true,
  },
  {
    kind: "hyrox_hard",
    family: "hyrox",
    title: "Gros Hyrox — 75 min",
    durationMin: 75,
    intensity: "hard",
    modality: "mixed_modal",
    loadVector: lv(9, 7, 6, 7, 5, 2),
    expectedCredits: { hi_conditioning: 1, threshold: 0.5 },
    patterns: { locomotion: 5, squat: 2, carry: 1.5, hinge: 1 },
    impactUnits: 10,
    equipment: ["outdoor", "ski_erg", "sled", "rower"],
    intentOnly: true,
  },
  {
    kind: "just_move_20",
    family: "just_move",
    title: "Juste bouger — 20 min",
    durationMin: 20,
    intensity: "easy",
    modality: "other",
    loadVector: lv(1.5, 1, 1, 0.5, 0, 0),
    expectedCredits: { mobility_recovery: 0.5, aerobic_easy: 0.3 },
    patterns: { locomotion: 1 },
    impactUnits: 1,
    equipment: [],
    recovery: true,
    intentOnly: true,
  },
];

export function catalogToCandidate(
  e: CatalogEntry,
  origin: Candidate["origin"] = "catalog",
): Candidate {
  return {
    kind: e.kind,
    family: e.family,
    title: e.title,
    durationMin: e.durationMin,
    intensity: e.intensity,
    heavyStrength: e.heavyStrength ?? false,
    modality: e.modality,
    loadVector: { ...e.loadVector },
    expectedCredits: { ...e.expectedCredits },
    patterns: { ...e.patterns },
    impactUnits: e.impactUnits ?? 0,
    equipment: e.equipment,
    recovery: e.recovery ?? false,
    isTest: e.isTest,
    testKey: e.testKey,
    templateId: e.templateId,
    origin,
    profileConfidence: 1,
  };
}

export function getCatalogEntry(kind: string): CatalogEntry | undefined {
  return CANDIDATE_CATALOG.find((c) => c.kind === kind);
}

/** The static prior for a fixed class whose WOD is unknown (ENGINE.md §3, defaults.ts). */
export function crossfitClassPrior(): LoadProfile {
  return {
    expectedCredits: { ...CROSSFIT_CLASS_PRIOR_CREDITS },
    loadVector: { ...(REFERENCE_LOAD.crossfit_class_prior ?? lv(7, 5, 4, 4, 4, 4)) },
    intensity: "hard",
    heavyStrength: false,
    durationMin: 60,
    modality: "mixed_modal",
    patterns: {
      squat: 1.5,
      hinge: 1.5,
      vertical_pull: 1,
      horizontal_push: 1,
      locomotion: 1.5,
      olympic_lift: 0.5,
      gymnastics: 0.5,
    },
    impactUnits: 3,
  };
}

/** Which catalog kinds an intent asks for (exact) and tolerates (partial). */
export function intentFamilies(intent: UserIntent): {
  exact: string[];
  partial: string[];
  exclude: (c: Candidate) => boolean;
} {
  const byIntensity = (fams: { easy: string[]; hard: string[]; any: string[] }) =>
    intent.intensity === "hard" ? fams.hard : intent.intensity === "easy" ? fams.easy : fams.any;
  const none = () => false;
  switch (intent.kind) {
    case "want_run":
      return {
        exact: byIntensity({
          easy: ["run_easy", "run_long"],
          hard: ["run_hard"],
          any: ["run_easy", "run_long", "run_hard"],
        }),
        partial: ["walk", "hyrox"],
        exclude: none,
      };
    case "want_bike":
      return {
        exact: byIntensity({
          easy: ["bike_easy", "bike_long", "recovery_spin"],
          hard: ["bike_hard"],
          any: ["bike_easy", "bike_long", "bike_hard"],
        }),
        partial: ["recovery_spin"],
        exclude: none,
      };
    case "want_row":
      return { exact: ["row"], partial: ["ski"], exclude: none };
    case "want_crossfit":
    case "going_crossfit":
      return { exact: ["crossfit"], partial: ["partner", "benchmark"], exclude: none };
    case "want_strength":
      return {
        exact: ["strength_lower", "strength_upper", "strength_full"],
        partial: ["accessory", "olympic", "gymnastics"],
        exclude: none,
      };
    case "want_hyrox":
      return {
        exact: byIntensity({ easy: ["hyrox"], hard: ["hyrox"], any: ["hyrox"] }),
        partial: ["run_hard", "run_easy"],
        exclude: none,
      };
    case "want_big_session":
    case "feel_hot":
      return {
        exact: ["partner", "benchmark", "hyrox", "run_hard", "bike_hard", "test", "crossfit"],
        partial: ["strength_lower", "strength_full"],
        exclude: none,
      };
    case "no_strength":
      return {
        exact: [],
        partial: [],
        exclude: (c) => c.family.startsWith("strength") || c.family === "accessory",
      };
    case "no_legs":
      return {
        exact: ["strength_upper", "accessory", "gymnastics", "ski", "row"],
        partial: ["mobility"],
        exclude: (c) => c.loadVector.muscular_lower >= 5,
      };
    case "just_move":
      return {
        exact: ["just_move", "walk", "recovery_spin", "mobility", "row", "ski"],
        partial: ["run_easy", "bike_easy"],
        exclude: (c) => c.intensity !== "easy",
      };
    case "lazy":
      return {
        exact: ["just_move", "walk", "recovery_spin", "mobility", "rest"],
        partial: ["row", "bike_easy"],
        exclude: (c) => c.intensity !== "easy" || c.durationMin > 45,
      };
    case "rest":
      return { exact: ["rest"], partial: ["mobility", "walk"], exclude: (c) => !c.recovery };
    case "surprise":
      return {
        exact: ["partner", "hyrox", "run_long", "bike_long", "walk", "gymnastics"],
        partial: [],
        exclude: none,
      };
    case "have_time":
    case "custom":
    default:
      return { exact: [], partial: [], exclude: none };
  }
}

/** Exact = family asked AND intensity compatible; partial = same family other intensity, or a tolerated family. */
export function intentMatch(intent: UserIntent, c: Candidate): "exact" | "partial" | "none" {
  const fams = intentFamilies(intent);
  if (fams.exact.includes(c.family)) {
    if (!intent.intensity || c.family === "rest" || c.intensity === intent.intensity)
      return "exact";
    return "partial";
  }
  if (fams.partial.includes(c.family)) return "partial";
  return "none";
}

/**
 * Build the candidate list for a day: catalog (filtered by equipment/availability/intent), generated
 * CrossFit candidates for fixed classes, and intent-only families when asked.
 */
export function buildCandidates(args: {
  todayFixed: PlannedSession[];
  todayPlannedFree: PlannedSession[];
  intent: UserIntent | null;
  equipment: Equipment[];
  largestWindowMin: number;
  fresh: boolean;
  boxPrior?: { profile: LoadProfile; confidence: number } | null;
}): Candidate[] {
  const out: Candidate[] = [];
  const intent = args.intent;
  const fams = intent ? intentFamilies(intent) : null;
  const equipmentOk = (c: Candidate) =>
    c.equipment.length === 0 ||
    c.equipment.some((e) => args.equipment.includes(e) || e === "bodyweight" || e === "outdoor");

  for (const e of CANDIDATE_CATALOG) {
    if (
      e.intentOnly &&
      !(fams && (fams.exact.includes(e.family) || fams.partial.includes(e.family)))
    )
      continue;
    if (e.isTest && !args.fresh && !(fams && fams.exact.includes("test"))) continue;
    const c = catalogToCandidate(e, e.intentOnly ? "intent" : "catalog");
    if (!equipmentOk(c)) continue;
    if (fams && fams.exclude(c)) continue;
    // Availability: swap for a shorter variant instead of dropping when one exists (run_easy_60 → 45).
    if (args.largestWindowMin > 0 && c.durationMin > args.largestWindowMin) {
      const shorter = CANDIDATE_CATALOG.find(
        (x) => x.family === e.family && x.durationMin <= args.largestWindowMin && !x.intentOnly,
      );
      if (shorter && shorter.kind !== e.kind) continue; // the shorter one will be added in its own turn
      if (!shorter && c.kind !== "rest") continue;
    }
    out.push(c);
  }

  // Fixed CrossFit class today → generated candidates (never on a day without a class).
  for (const p of args.todayFixed) {
    if (p.type !== "crossfit") continue;
    if (p.profile && (p.wodStatus === "confirmed" || (p.wodConfidence ?? 0) >= 0.7)) {
      out.push({
        ...p.profile,
        kind: "crossfit_as_programmed",
        family: "crossfit",
        title: p.title || "CrossFit",
        equipment: [],
        recovery: false,
        origin: "crossfit_as_programmed",
        profileConfidence: p.wodStatus === "confirmed" ? 1 : (p.wodConfidence ?? 0.7),
        plannedId: p.id,
        fixed: true,
        timeOfDay: timeOfDayOf(p.startMinute),
      });
    } else if (p.profile && (p.wodConfidence ?? 0) >= 0.5) {
      const prior = crossfitClassPrior();
      const blended = blendProfiles(p.profile, prior, 0.5);
      out.push({
        ...blended,
        kind: "crossfit_as_programmed",
        family: "crossfit",
        title: p.title || "CrossFit",
        equipment: [],
        recovery: false,
        origin: "crossfit_as_programmed",
        profileConfidence: 0.6,
        plannedId: p.id,
        fixed: true,
        timeOfDay: timeOfDayOf(p.startMinute),
      });
    } else {
      const prior =
        args.boxPrior && args.boxPrior.confidence >= 0.5
          ? args.boxPrior.profile
          : crossfitClassPrior();
      out.push({
        ...prior,
        kind: "crossfit_generic",
        family: "crossfit",
        title: p.title || "CrossFit (WOD inconnu)",
        equipment: [],
        recovery: false,
        origin: "crossfit_generic",
        profileConfidence:
          args.boxPrior && args.boxPrior.confidence >= 0.5
            ? args.boxPrior.confidence
            : CROSSFIT_CLASS_PRIOR_CONFIDENCE,
        plannedId: p.id,
        fixed: true,
        timeOfDay: timeOfDayOf(p.startMinute),
      });
    }
  }
  // Other fixed sessions (coaching, events) become candidates too so they can be the primary.
  for (const p of args.todayFixed) {
    if (p.type === "crossfit") continue;
    const profile = p.profile ?? {
      expectedCredits: {},
      loadVector: lv(1, 1, 1, 0, 0, 0),
      intensity: "easy" as const,
      heavyStrength: false,
      durationMin: 60,
      modality: "other" as const,
      patterns: {},
      impactUnits: 0,
    };
    out.push({
      ...profile,
      kind: p.kind ?? p.type,
      family: p.type,
      title: p.title,
      equipment: [],
      recovery: p.type === "rest" || p.type === "mobility",
      origin: "catalog",
      profileConfidence: p.profile ? 1 : 0.5,
      plannedId: p.id,
      fixed: true,
      timeOfDay: timeOfDayOf(p.startMinute),
    });
  }
  // Intent going_crossfit without a class → generic with askFor 'wod' (handled by the engine).
  if (intent?.kind === "going_crossfit" && !args.todayFixed.some((p) => p.type === "crossfit")) {
    out.push({
      ...crossfitClassPrior(),
      kind: "crossfit_generic",
      family: "crossfit",
      title: "CrossFit (WOD inconnu)",
      equipment: [],
      recovery: false,
      origin: "crossfit_generic",
      profileConfidence: CROSSFIT_CLASS_PRIOR_CONFIDENCE,
    });
  }
  // Planned free sessions today are represented by their catalog kind (adherence bonus applied by rules).
  for (const p of args.todayPlannedFree) {
    const idx = out.findIndex((c) => c.kind === p.kind);
    if (idx >= 0) {
      const existing = out[idx] as Candidate;
      out[idx] = {
        ...existing,
        plannedId: p.id,
        timeOfDay: timeOfDayOf(p.startMinute) ?? existing.timeOfDay,
      };
    } else if (p.profile) {
      out.push({
        ...p.profile,
        kind: p.kind ?? p.type,
        family: p.family ?? p.type,
        title: p.title,
        equipment: [],
        recovery: false,
        origin: "catalog",
        profileConfidence: 1,
        plannedId: p.id,
        timeOfDay: timeOfDayOf(p.startMinute),
      });
    }
  }
  return out;
}

export function timeOfDayOf(startMinute?: number | null): Candidate["timeOfDay"] {
  if (startMinute == null) return undefined;
  if (startMinute < 11 * 60) return "morning";
  if (startMinute < 16 * 60) return "midday";
  return "evening";
}

export function blendProfiles(a: LoadProfile, b: LoadProfile, wa: number): LoadProfile {
  const wb = 1 - wa;
  const credits: StimulusCredits = {};
  const keys = new Set([
    ...Object.keys(a.expectedCredits),
    ...Object.keys(b.expectedCredits),
  ]) as Set<keyof StimulusCredits>;
  for (const k of keys)
    credits[k] = round2((a.expectedCredits[k] ?? 0) * wa + (b.expectedCredits[k] ?? 0) * wb);
  const patterns: PatternExposure = {};
  const pkeys = new Set([...Object.keys(a.patterns), ...Object.keys(b.patterns)]) as Set<
    keyof PatternExposure
  >;
  for (const k of pkeys)
    patterns[k] = round2((a.patterns[k] ?? 0) * wa + (b.patterns[k] ?? 0) * wb);
  return {
    expectedCredits: credits,
    loadVector: {
      cardiovascular: round2(a.loadVector.cardiovascular * wa + b.loadVector.cardiovascular * wb),
      muscular_lower: round2(a.loadVector.muscular_lower * wa + b.loadVector.muscular_lower * wb),
      muscular_upper: round2(a.loadVector.muscular_upper * wa + b.loadVector.muscular_upper * wb),
      impact: round2(a.loadVector.impact * wa + b.loadVector.impact * wb),
      eccentric: round2(a.loadVector.eccentric * wa + b.loadVector.eccentric * wb),
      technical: round2(a.loadVector.technical * wa + b.loadVector.technical * wb),
    },
    intensity:
      a.intensity === "hard" || b.intensity === "hard"
        ? "hard"
        : a.intensity === "moderate" || b.intensity === "moderate"
          ? "moderate"
          : "easy",
    heavyStrength: a.heavyStrength || b.heavyStrength,
    durationMin: Math.round(a.durationMin * wa + b.durationMin * wb),
    modality: a.modality,
    patterns,
    impactUnits: round2(a.impactUnits * wa + b.impactUnits * wb),
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
