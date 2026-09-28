import {
  emptyLoadVector,
  type EnergySystem,
  type Modality,
  type MovementPattern,
  type MuscleExposure,
  type MuscleGroup,
  type PatternExposure,
  type StimulusCredits,
} from "../core";
import { getExercise, type ExerciseDef } from "../exercises";
import { classifyIntensity } from "../load/intensity";
import { impactDimension, impactUnits } from "../load/impact";
import type { NormalizedWod, WodMovement, WodPart } from "./schema";
import type { MovementTotals, TimeDomain, WodAnalysis, WodDominant } from "./types";

export const WOD_ANALYZER_VERSION = "wod_analyzer_v1" as const;

export interface AnalyzeOptions {
  /** Credit `crossfit_exposure` (true when the WOD is a box class / CrossFit session). Default true. */
  isCrossfitSession?: boolean;
  /** Known e1RMs by exercise id (kg) to turn absolute loads into %1RM. */
  e1rms?: Readonly<Record<string, number>>;
  /** Per-exercise learned cost multipliers from the athlete model (1 = default). */
  exerciseCostMultipliers?: Readonly<Record<string, number>>;
  bodyweightKg?: number | null;
}

// ---------------------------------------------------------------------------
// Calibration constants (documented; changing them bumps WOD_ANALYZER_VERSION).
// Muscular dims: saturating 10·raw/(raw+K) over work units × cost × intensity.
// Cardio dim: saturating over intensity-weighted minutes (easy 0.3, moderate 2, hard 13 per min):
//   12′ hard metcon → 8.0 ; 60′ Z2 → 3.1 ; 30′ easy row → 1.8 ; 5′ Fran → 6.2.
// ---------------------------------------------------------------------------
const K_LOWER = 30;
const K_UPPER = 35;
const K_CARDIO = 40;
const K_ECCENTRIC = 25;
const K_TECHNICAL = 15;
const EXPOSURE_PER_UNIT = 0.04;
/** Intensity factor for conditioning parts at light/moderate loads (relative to a heavy set = 1.3). */
const METCON_INTENSITY = 0.5;
/** Muscular cost of conditioning volume is sub-linear vs strength volume. */
const METCON_MUSCULAR_DAMPING = 0.6;
const MONO_MUSCULAR_FACTOR = 0.4;
const STRENGTH_INTENSITY_BY_QUALIFIER = { light: 0.8, moderate: 1.0, heavy: 1.3, build: 1.2 } as const;
const CARDIO_WEIGHT_PER_MIN = { easy: 0.3, moderate: 2, hard: 13, strength: 0.5 } as const;

/** Rough time per unit for pacing estimates (seconds). */
const SEC_PER_REP_DEFAULT = 3;
const SEC_PER_CAL: Record<string, number> = { row: 3.5, bike_erg: 3.6, assault_bike: 4, ski_erg: 3.8 };
const SEC_PER_100M: Record<string, number> = { run: 30, row: 24, ski_erg: 25, swim: 110, walk: 60, bike_erg: 12, handstand_walk: 90, farmer_carry: 40, front_rack_carry: 45, overhead_carry: 50, sandbag_carry: 45, sled_push: 45, sled_pull: 45 };

type DefLike = Pick<ExerciseDef, "cost" | "impactLevel" | "eccentricLoad" | "technicalDifficulty" | "primaryMuscles" | "secondaryMuscles" | "movementPattern" | "secondaryPatterns" | "modality" | "measurementType" | "category"> & { id: string | null; name: string };

/** Conservative defaults for unknown movements, keyed by hinted pattern (ENGINE.md §9). */
function unknownDefaults(hint: MovementPattern | null, name: string): DefLike {
  const pattern: MovementPattern = hint ?? "rotation_core";
  const musclesByPattern: Record<MovementPattern, MuscleGroup[]> = {
    squat: ["quads", "glutes"],
    hinge: ["hamstrings", "glutes", "lower_back"],
    horizontal_push: ["chest", "triceps", "shoulders"],
    vertical_push: ["shoulders", "triceps"],
    horizontal_pull: ["upper_back", "lats", "biceps"],
    vertical_pull: ["lats", "biceps"],
    carry: ["core", "forearms_grip", "traps"],
    locomotion: ["quads", "calves", "glutes"],
    rotation_core: ["core"],
    olympic_lift: ["glutes", "hamstrings", "quads", "traps"],
    gymnastics: ["shoulders", "core", "lats"],
    isolation: ["core"],
  };
  const lowerPatterns: MovementPattern[] = ["squat", "hinge", "locomotion", "olympic_lift"];
  const upperPatterns: MovementPattern[] = ["horizontal_push", "vertical_push", "horizontal_pull", "vertical_pull", "gymnastics", "carry"];
  return {
    id: null,
    name,
    cost: { lower: lowerPatterns.includes(pattern) ? 1.5 : 0.3, upper: upperPatterns.includes(pattern) ? 1.5 : 0.3, cardio: 1.5 },
    impactLevel: pattern === "locomotion" ? 2 : 0,
    eccentricLoad: 1,
    technicalDifficulty: 3,
    primaryMuscles: musclesByPattern[pattern],
    secondaryMuscles: [],
    movementPattern: pattern,
    secondaryPatterns: [],
    modality: undefined,
    measurementType: "reps",
    category: "other",
  };
}

interface Resolved {
  movement: WodMovement;
  def: DefLike;
  unknown: boolean;
}

function resolve(m: WodMovement): Resolved {
  const ex = m.exerciseId ? getExercise(m.exerciseId) : undefined;
  if (ex) return { movement: m, def: { ...ex, id: ex.id, name: ex.name }, unknown: false };
  return { movement: m, def: unknownDefaults(m.hintedPattern, m.name), unknown: true };
}

interface Quantities {
  reps: number;
  distanceM: number;
  calories: number;
  durationSec: number;
  sets: number;
}

/** Quantities for ONE execution of a movement (one round / one set). */
function perExecution(part: WodPart, m: WodMovement, def: DefLike): Quantities {
  const sets = m.sets ?? (part.format === "sets_reps" ? (part.sets ?? 1) : 1);
  let reps = 0;
  let calories = m.calories ?? 0;
  const distanceM = m.distanceM ?? 0;
  const durationSec = m.durationSec ?? 0;
  const hasQty = m.reps != null || m.repScheme != null || calories > 0 || distanceM > 0 || durationSec > 0;
  if (m.repScheme && m.repScheme.length) reps = m.repScheme.reduce((a, b) => a + b, 0);
  else if (m.reps != null) reps = m.reps;
  else if (!hasQty && part.repScheme && part.repScheme.length) {
    const total = part.repScheme.reduce((a, b) => a + b, 0);
    if (def.measurementType === "calories") calories = total;
    else reps = total;
  } else if (!hasQty && part.format === "sets_reps" && part.reps != null) reps = part.reps;
  return { reps, distanceM, calories, durationSec, sets };
}

function secondsForExecution(def: DefLike, q: Quantities, loadKg: number | null): number {
  let s = 0;
  if (q.reps) s += q.reps * SEC_PER_REP_DEFAULT * (def.technicalDifficulty >= 4 ? 1.4 : 1) * (loadKg && loadKg >= 60 ? 1.3 : 1);
  if (q.calories) s += q.calories * (SEC_PER_CAL[def.id ?? ""] ?? 3.8);
  if (q.distanceM) s += (q.distanceM / 100) * (SEC_PER_100M[def.id ?? ""] ?? 35);
  if (q.durationSec) s += q.durationSec;
  return s;
}

/** Reps-equivalent work units: 25 m ≈ 1, 1.5 cal ≈ 1, 10 s of continuous work ≈ 1. */
function workUnits(q: Quantities): number {
  return q.reps + q.distanceM / 25 + q.calories / 1.5 + q.durationSec / 10;
}

function loadKgOf(m: WodMovement, bodyweightKg: number | null | undefined): number | null {
  const load = m.load;
  if (!load) return null;
  if (load.unit === "kg") return load.value;
  if (load.unit === "lb") return load.value * 0.4536;
  if (load.unit === "pood") return load.value * 16;
  if (load.unit === "bodyweight_ratio" && bodyweightKg) return load.value * bodyweightKg;
  return null;
}

/** Relative intensity of a movement's load (heavy set = 1.3, light conditioning = 0.5). */
function loadIntensity(part: WodPart, m: WodMovement, def: DefLike, e1rms: Readonly<Record<string, number>>, bodyweightKg: number | null | undefined): number {
  const conditioning = part.kind !== "strength" && part.kind !== "skill" && part.kind !== "accessory";
  const base = conditioning ? METCON_INTENSITY : 1.0;
  const load = m.load;
  if (!load) return conditioning ? base : 1.0;
  if (load.qualifier) return conditioning ? Math.max(base, STRENGTH_INTENSITY_BY_QUALIFIER[load.qualifier] * 0.6) : STRENGTH_INTENSITY_BY_QUALIFIER[load.qualifier];
  if (load.unit === "percent_1rm") {
    const pct = load.value / 100;
    return conditioning ? Math.max(base, pct) : 0.6 + pct * 0.8; // 100 % → 1.4, 70 % → 1.16
  }
  const kg = loadKgOf(m, bodyweightKg);
  if (kg == null) return base;
  const e1rm = def.id ? e1rms[def.id] : undefined;
  if (e1rm && e1rm > 0) {
    const pct = kg / e1rm;
    return conditioning ? Math.max(base, Math.min(1.2, pct + 0.1)) : 0.6 + Math.min(1.1, pct) * 0.8;
  }
  if (conditioning) return kg >= 60 ? 0.8 : kg >= 40 ? 0.65 : base;
  return kg >= 100 ? 1.3 : kg >= 60 ? 1.15 : 1.0;
}

function saturate(raw: number, k: number): number {
  return Math.round(((10 * raw) / (raw + k)) * 100) / 100;
}

const TIMED_FORMATS = new Set(["for_time", "amrap", "emom", "intervals", "tabata", "chipper", "ladder"]);

export function analyzeWod(wod: NormalizedWod, options: AnalyzeOptions = {}): WodAnalysis {
  const e1rms = options.e1rms ?? {};
  const costMult = options.exerciseCostMultipliers ?? {};
  const warnings: string[] = [...wod.warnings];
  const unknownMovements: string[] = [];

  const raw = { lower: 0, upper: 0, eccentric: 0, technical: 0 };
  const strengthRaw = { lower: 0, upper: 0 };
  let cardioWeightedMinutes = 0;
  const patternExposure: PatternExposure = {};
  const muscleExposure: MuscleExposure = {};
  const totalsById = new Map<string, MovementTotals>();
  const impactCounts = { runKm: 0, walkKm: 0, doubleUnders: 0, singleUnders: 0, boxJumps: 0, burpees: 0, jumpingLunges: 0 };
  const modalities = new Set<Modality>();
  let estimatedDurationMin = 0;
  let metconMinutes = 0;
  let hypertrophyReps = 0;
  let olyRepsStrength = 0;
  let olyRepsMetcon = 0;
  let gymSkillReps = 0;
  let powerReps = 0;
  let highRate = false;
  let easyAerobicMinutes = 0;
  let unparseable = 0;
  let hasTimedMetcon = false;
  const metconCategories = new Set<string>();

  for (const part of wod.parts) {
    const resolved = part.movements.map(resolve);
    for (const r of resolved) if (r.unknown) unknownMovements.push(r.movement.raw);
    const isConditioning = part.kind === "metcon";
    const timed = TIMED_FORMATS.has(part.format);

    // Pacing: seconds for one round of the part.
    let roundSec = 0;
    for (const r of resolved) roundSec += secondsForExecution(r.def, perExecution(part, r.movement, r.def), loadKgOf(r.movement, options.bodyweightKg));
    roundSec = roundSec * 1.15 + 5 * Math.max(0, resolved.length - 1);

    let estimatedRounds = 1;
    let partMinutes = 0;
    if (part.format === "amrap") {
      const dur = part.durationMin ?? 12;
      estimatedRounds = roundSec > 0 ? Math.max(1, (dur * 60) / roundSec) : 1;
      partMinutes = dur;
    } else if (part.format === "emom") {
      const interval = part.intervalSec ?? 60;
      const dur = part.durationMin ?? (part.rounds ? (part.rounds * interval) / 60 : 10);
      estimatedRounds = part.rounds ?? Math.max(1, Math.round((dur * 60) / interval));
      partMinutes = dur;
    } else if (part.format === "tabata") {
      estimatedRounds = part.rounds ?? 8;
      partMinutes = part.durationMin ?? (estimatedRounds * 30) / 60;
    } else if (part.format === "sets_reps") {
      const setsTotal = resolved.reduce((a, r) => a + perExecution(part, r.movement, r.def).sets, 0);
      partMinutes = Math.max(5, (setsTotal * ((part.reps ?? 5) * 4 + (part.kind === "strength" ? 150 : 75))) / 60);
    } else {
      const rounds = part.rounds ?? 1;
      const est = (roundSec * rounds + (part.restSec ?? 0) * Math.max(0, rounds - 1)) / 60;
      partMinutes = part.durationMin ?? (part.timeCapMin ? Math.min(part.timeCapMin, est) : est);
    }
    estimatedDurationMin += partMinutes;
    if (isConditioning && timed) {
      metconMinutes += partMinutes;
      hasTimedMetcon = true;
    }
    const execs = (() => {
      switch (part.format) {
        case "amrap":
        case "tabata":
          return Math.max(1, estimatedRounds);
        case "emom":
          return part.alternating && part.movements.length > 1 ? Math.max(1, estimatedRounds / part.movements.length) : Math.max(1, estimatedRounds);
        case "for_time":
        case "intervals":
        case "ladder":
          return part.rounds ?? 1;
        default:
          return 1;
      }
    })();

    // Part-level high-rate flag: timed metcon with a cardio-heavy movement at light load.
    let partHighRate = false;
    let partMuscularUnits = 0;

    for (const r of resolved) {
      const q = perExecution(part, r.movement, r.def);
      if (q.reps === 0 && q.distanceM === 0 && q.calories === 0 && q.durationSec === 0) unparseable++;
      const units = workUnits(q) * q.sets * execs;
      const mult = r.def.id ? (costMult[r.def.id] ?? 1) : 1;
      const intensity = loadIntensity(part, r.movement, r.def, e1rms, options.bodyweightKg);
      const paceFactor = r.movement.pace === "easy" ? 0.35 : r.movement.pace === "moderate" ? 0.7 : 1;
      const cost = r.def.cost;
      const isMono = r.def.category === "monostructural" && r.def.modality !== undefined;
      // Continuous monostructural work (row/bike/run) costs less muscle per unit than metcon reps.
      const muscularDamping = (isConditioning ? METCON_MUSCULAR_DAMPING : 1) * (isMono ? MONO_MUSCULAR_FACTOR : 1);
      const minutesForMovement = (secondsForExecution(r.def, q, loadKgOf(r.movement, options.bodyweightKg)) * q.sets * execs) / 60;

      raw.lower += units * cost.lower * intensity * mult * muscularDamping * paceFactor;
      raw.upper += units * cost.upper * intensity * mult * muscularDamping * paceFactor;
      raw.eccentric += units * r.def.eccentricLoad * intensity * mult * muscularDamping * paceFactor;
      if (isConditioning) raw.technical += units * (Math.max(0, r.def.technicalDifficulty - 3) / 2) * 0.8;
      else raw.technical += units * (Math.max(0, r.def.technicalDifficulty - 2) / 3);
      if (part.kind === "strength" || part.kind === "accessory") {
        strengthRaw.lower += units * cost.lower * intensity * mult;
        strengthRaw.upper += units * cost.upper * intensity * mult;
        if (q.reps >= 8 && q.reps <= 15) hypertrophyReps += units;
      }
      if (isConditioning && timed && cost.cardio >= 2 && intensity <= 0.8 && r.movement.pace !== "easy") partHighRate = true;
      partMuscularUnits += units;

      const exposure = units * (cost.lower + cost.upper) * EXPOSURE_PER_UNIT * intensity * mult * muscularDamping * paceFactor;
      patternExposure[r.def.movementPattern] = (patternExposure[r.def.movementPattern] ?? 0) + exposure;
      for (const sp of r.def.secondaryPatterns ?? []) patternExposure[sp] = (patternExposure[sp] ?? 0) + exposure * 0.5;
      for (const mg of r.def.primaryMuscles) muscleExposure[mg] = (muscleExposure[mg] ?? 0) + exposure * 0.6;
      for (const mg of r.def.secondaryMuscles ?? []) muscleExposure[mg] = (muscleExposure[mg] ?? 0) + exposure * 0.25;

      const isOly = r.def.movementPattern === "olympic_lift" || (r.def.secondaryPatterns ?? []).includes("olympic_lift");
      if (isOly) {
        if (part.kind === "strength" || part.kind === "skill") olyRepsStrength += units;
        else olyRepsMetcon += units;
      }
      const isGym = r.def.movementPattern === "gymnastics" || (r.def.secondaryPatterns ?? []).includes("gymnastics") || r.def.category === "gymnastics";
      if (isGym && r.def.technicalDifficulty >= 3) gymSkillReps += units;
      if (["box_jump", "box_jump_over", "power_clean", "power_snatch", "kettlebell_swing"].includes(r.def.id ?? "")) powerReps += units;
      if (r.def.modality) modalities.add(r.def.modality);
      if (isConditioning) metconCategories.add(r.def.category);

      // Cardio: intensity-weighted minutes.
      if (isConditioning && timed) {
        // weight decided at part level below; accumulate minutes here
      } else if (isMono) {
        const w = r.movement.pace === "easy" ? CARDIO_WEIGHT_PER_MIN.easy : r.movement.pace === "hard" ? CARDIO_WEIGHT_PER_MIN.hard : CARDIO_WEIGHT_PER_MIN.moderate;
        cardioWeightedMinutes += minutesForMovement * w;
        if (r.movement.pace === "easy" || (r.movement.pace == null && part.kind !== "metcon")) easyAerobicMinutes += minutesForMovement;
      } else {
        cardioWeightedMinutes += minutesForMovement * (isConditioning ? CARDIO_WEIGHT_PER_MIN.moderate : CARDIO_WEIGHT_PER_MIN.strength);
      }

      // Impact counts
      const totalReps = q.reps * q.sets * execs;
      const totalDist = q.distanceM * q.sets * execs;
      const totalDur = q.durationSec * q.sets * execs;
      if (r.def.id === "run") impactCounts.runKm += totalDist / 1000 + (totalDist === 0 && totalDur > 0 ? totalDur / 300 : 0);
      if (r.def.id === "walk") impactCounts.walkKm += totalDist / 1000;
      if (r.def.id === "double_under") impactCounts.doubleUnders += totalReps;
      if (r.def.id === "single_under") impactCounts.singleUnders += totalReps;
      if (r.def.id === "box_jump" || r.def.id === "box_jump_over") impactCounts.boxJumps += totalReps;
      if (r.def.id === "burpee" || r.def.id === "bar_facing_burpee" || r.def.id === "devil_press") impactCounts.burpees += totalReps;
      if (r.def.id === "burpee_box_jump_over") {
        impactCounts.burpees += totalReps;
        impactCounts.boxJumps += totalReps;
      }
      if (r.def.id === "lunge" && r.movement.modifiers.includes("jumping")) impactCounts.jumpingLunges += totalReps;

      const key = r.def.id ?? `raw:${r.movement.raw.toLowerCase()}`;
      const t = totalsById.get(key) ?? { exerciseId: r.def.id, name: r.def.name, totalReps: 0, totalDistanceM: 0, totalCalories: 0, totalDurationSec: 0, loadKg: null, workUnits: 0 };
      t.totalReps += totalReps;
      t.totalDistanceM += totalDist;
      t.totalCalories += q.calories * q.sets * execs;
      t.totalDurationSec += totalDur;
      t.workUnits += units;
      const kg = loadKgOf(r.movement, options.bodyweightKg);
      if (kg != null && kg > 0) t.loadKg = Math.max(t.loadKg ?? 0, kg);
      totalsById.set(key, t);
    }

    if (isConditioning && timed) {
      const easyOnly = resolved.every((r) => r.movement.pace === "easy");
      const weight = easyOnly ? CARDIO_WEIGHT_PER_MIN.easy : partHighRate ? CARDIO_WEIGHT_PER_MIN.hard : part.format === "emom" ? CARDIO_WEIGHT_PER_MIN.moderate * 3 : CARDIO_WEIGHT_PER_MIN.moderate * 3;
      cardioWeightedMinutes += partMinutes * weight;
      if (partHighRate) highRate = true;
      if (easyOnly) easyAerobicMinutes += partMinutes;
    }
    void partMuscularUnits;
  }

  const iu = impactUnits(impactCounts);
  const loadVector = emptyLoadVector();
  loadVector.muscular_lower = saturate(raw.lower, K_LOWER);
  loadVector.muscular_upper = saturate(raw.upper, K_UPPER);
  loadVector.cardiovascular = saturate(cardioWeightedMinutes, K_CARDIO);
  loadVector.eccentric = saturate(raw.eccentric, K_ECCENTRIC);
  loadVector.technical = saturate(raw.technical, K_TECHNICAL);
  loadVector.impact = impactDimension(iu);

  const domainMinutes = metconMinutes > 0 ? metconMinutes : estimatedDurationMin;
  const timeDomain: TimeDomain = domainMinutes <= 8 ? "short" : domainMinutes <= 20 ? "medium" : "long";

  const strengthShare = (strengthRaw.lower + strengthRaw.upper) / Math.max(1, raw.lower + raw.upper);
  const hasMetcon = wod.parts.some((p) => p.kind === "metcon");
  const hasStrength = wod.parts.some((p) => p.kind === "strength");
  const hasSkill = wod.parts.some((p) => p.kind === "skill");
  let dominant: WodDominant = "conditioning";
  if (hasStrength && hasTimedMetcon) dominant = "mixed";
  else if (hasStrength) dominant = hypertrophyReps > 40 && strengthShare > 0.5 ? "hypertrophy" : "strength";
  else if (hasSkill && !hasMetcon) dominant = "skill";

  const energySystems: EnergySystem[] = [];
  if (hasStrength) energySystems.push("phosphagen");
  if (hasTimedMetcon) {
    if (metconMinutes <= 5) energySystems.push("phosphagen", "glycolytic");
    else if (metconMinutes <= 20) {
      energySystems.push("glycolytic");
      if (metconMinutes > 12) energySystems.push("aerobic_threshold");
    } else energySystems.push("aerobic_threshold", "glycolytic");
  }
  if (easyAerobicMinutes >= 20) energySystems.push("aerobic_easy");
  if (!energySystems.length) energySystems.push(loadVector.cardiovascular >= 4 ? "aerobic_threshold" : "aerobic_easy");

  const intensity = classifyIntensity({
    loadVector,
    metcon: hasTimedMetcon ? { timeDomainMin: metconMinutes, highRate } : null,
    heavyStrength: hasStrength && strengthShare > 0.5,
  });

  const credits: StimulusCredits = options.isCrossfitSession === false ? {} : { crossfit_exposure: 1 };
  const sl = Math.min(1, strengthRaw.lower / 80) + Math.min(0.4, (raw.lower - strengthRaw.lower) / 300);
  const su = Math.min(1, strengthRaw.upper / 80) + Math.min(0.4, (raw.upper - strengthRaw.upper) / 300);
  if (sl >= 0.1) credits.strength_lower = round2(Math.min(1.2, sl));
  if (su >= 0.1) credits.strength_upper = round2(Math.min(1.2, su));
  if (hypertrophyReps > 0) credits.hypertrophy = round2(Math.min(1, hypertrophyReps / 60));
  const oly = olyRepsStrength / 20 + olyRepsMetcon / 40;
  if (oly >= 0.1) credits.olympic_technique = round2(Math.min(1, oly));
  if (gymSkillReps > 0) credits.gymnastics_skill = round2(Math.min(1, gymSkillReps / 30));
  if (powerReps > 0) credits.power = round2(Math.min(1, powerReps / 30));
  if (hasTimedMetcon) {
    if (intensity.band === "hard") credits.hi_conditioning = metconMinutes >= 8 ? 1 : 0.7;
    else if (intensity.band === "moderate") credits.hi_conditioning = 0.5;
  }
  if (easyAerobicMinutes >= 20) credits.aerobic_easy = round2(Math.min(1, easyAerobicMinutes / 45));
  if (easyAerobicMinutes >= 75) credits.aerobic_long = round2(Math.min(1, easyAerobicMinutes / 90));

  const tags: string[] = [];
  const top = (Object.entries(patternExposure) as Array<[MovementPattern, number]>).sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] > 0) tags.push(`${top[0]}_dominant`);
  if (loadVector.impact >= 5) tags.push("high_impact");
  if (loadVector.technical >= 6) tags.push("high_skill");
  if ((muscleExposure.forearms_grip ?? 0) >= 3) tags.push("grip_heavy");
  if ((patternExposure.vertical_push ?? 0) >= 3) tags.push("overhead_heavy");
  if (metconMinutes > 20) tags.push("long_metcon");
  if (hasMetcon && metconCategories.size >= 2) modalities.add("mixed_modal");
  if (hasStrength) modalities.add("strength");
  const allDefs = wod.parts.flatMap((p) => p.movements).map((m) => (m.exerciseId ? getExercise(m.exerciseId) : undefined));
  if (allDefs.some((d) => d?.category === "gymnastics")) modalities.add("gymnastics");
  if (allDefs.some((d) => d?.category === "olympic")) modalities.add("weightlifting");
  if (allDefs.some((d) => d?.category === "monostructural" && d.modality === "walking")) modalities.add("walking");

  let confidence = wod.parseConfidence;
  confidence -= 0.15 * unknownMovements.length;
  confidence -= 0.1 * unparseable;
  if (unknownMovements.length) confidence = Math.min(confidence, 0.6);
  confidence = Math.max(0, Math.min(1, confidence));
  if (unknownMovements.length) warnings.push(`Mouvements non reconnus : ${unknownMovements.join(", ")}`);
  if (unparseable) warnings.push(`${unparseable} mouvement(s) sans quantité exploitable`);

  return {
    algorithmVersion: WOD_ANALYZER_VERSION,
    estimatedDurationMin: Math.round(estimatedDurationMin),
    metconMinutes: Math.round(metconMinutes),
    timeDomain,
    dominant,
    intensity: intensity.band,
    intensityReason: intensity.reason,
    highRate,
    energySystems: [...new Set(energySystems)],
    modalities: [...modalities],
    patternExposure: roundMap(patternExposure),
    muscleExposure: roundMap(muscleExposure),
    loadVector,
    impactUnits: iu,
    stimulusCredits: credits,
    movements: [...totalsById.values()].map((t) => ({ ...t, totalReps: Math.round(t.totalReps), workUnits: round2(t.workUnits), totalDistanceM: Math.round(t.totalDistanceM), totalCalories: Math.round(t.totalCalories), totalDurationSec: Math.round(t.totalDurationSec) })),
    tags,
    unknownMovements,
    confidence: round2(confidence),
    warnings,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
function roundMap<K extends string>(m: Partial<Record<K, number>>): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const [k, v] of Object.entries(m) as Array<[K, number]>) out[k] = round2(v);
  return out;
}
