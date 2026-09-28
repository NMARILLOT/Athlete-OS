import type { LoadVector, UserIntent, WorkoutType } from "../core";
import { addDays, type IsoDate } from "../core/dates";
import { buildAthleteModel } from "../athlete-model";
import { deriveWeeklyTargets } from "../stimulus/targets";
import { crossfitClassPrior, getCatalogEntry } from "./candidates";
import type { EngineInput, HistorySession, LoadProfile, PlannedSession } from "./types";

/**
 * Test fixtures for the engine. Exported from the domain so integration tests and the seed script
 * can build realistic inputs without duplicating physiology numbers.
 */
export const NICOLAS_GOALS = {
  health_longevity: 1,
  crossfit: 0.9,
  endurance: 0.9,
  strength: 0.9,
  physique: 0.6,
  fun: 0.7,
} as const;

export const PROFILES: Record<string, LoadProfile> = {
  heavy_squat_wallballs: {
    expectedCredits: { crossfit_exposure: 1, strength_lower: 1, hi_conditioning: 1 },
    loadVector: {
      cardiovascular: 8,
      muscular_lower: 8.5,
      muscular_upper: 6,
      impact: 2,
      eccentric: 8,
      technical: 3.5,
    },
    intensity: "hard",
    heavyStrength: true,
    durationMin: 60,
    modality: "mixed_modal",
    patterns: { squat: 7, locomotion: 3, horizontal_push: 2 },
    impactUnits: 1.5,
  },
  front_squat_class: {
    expectedCredits: { crossfit_exposure: 1, strength_lower: 0.9, hi_conditioning: 0.7 },
    loadVector: {
      cardiovascular: 6.5,
      muscular_lower: 7.5,
      muscular_upper: 4,
      impact: 1,
      eccentric: 7,
      technical: 3,
    },
    intensity: "hard",
    heavyStrength: true,
    durationMin: 60,
    modality: "mixed_modal",
    patterns: { squat: 6, vertical_pull: 2 },
    impactUnits: 0.5,
  },
  deadlift_crossfit: {
    expectedCredits: { crossfit_exposure: 1, strength_lower: 1, hi_conditioning: 0.7 },
    loadVector: {
      cardiovascular: 6.5,
      muscular_lower: 8,
      muscular_upper: 6,
      impact: 0,
      eccentric: 7.5,
      technical: 2.5,
    },
    intensity: "hard",
    heavyStrength: true,
    durationMin: 60,
    modality: "mixed_modal",
    patterns: { hinge: 8, locomotion: 1.5 },
    impactUnits: 0,
  },
  run_intervals: {
    expectedCredits: { vo2max: 1 },
    loadVector: {
      cardiovascular: 9,
      muscular_lower: 5,
      muscular_upper: 0,
      impact: 7,
      eccentric: 4,
      technical: 1,
    },
    intensity: "hard",
    heavyStrength: false,
    durationMin: 50,
    modality: "running",
    patterns: { locomotion: 4 },
    impactUnits: 8,
  },
  easy_run_45: {
    expectedCredits: { aerobic_easy: 1 },
    loadVector: {
      cardiovascular: 2.5,
      muscular_lower: 2,
      muscular_upper: 0,
      impact: 4,
      eccentric: 1.5,
      technical: 0,
    },
    intensity: "easy",
    heavyStrength: false,
    durationMin: 45,
    modality: "running",
    patterns: { locomotion: 3 },
    impactUnits: 8,
  },
  easy_bike_60: {
    expectedCredits: { aerobic_easy: 1.2 },
    loadVector: {
      cardiovascular: 3,
      muscular_lower: 2,
      muscular_upper: 0,
      impact: 0,
      eccentric: 0,
      technical: 0,
    },
    intensity: "easy",
    heavyStrength: false,
    durationMin: 60,
    modality: "bike",
    patterns: { locomotion: 4 },
    impactUnits: 0,
  },
  upper_strength: {
    expectedCredits: { strength_upper: 1, hypertrophy: 0.5 },
    loadVector: {
      cardiovascular: 2,
      muscular_lower: 0.5,
      muscular_upper: 8,
      impact: 0,
      eccentric: 4,
      technical: 2,
    },
    intensity: "moderate",
    heavyStrength: true,
    durationMin: 60,
    modality: "strength",
    patterns: { horizontal_push: 2, horizontal_pull: 2, vertical_push: 1.5, vertical_pull: 1.5 },
    impactUnits: 0,
  },
  mobility: {
    expectedCredits: { mobility_recovery: 1 },
    loadVector: {
      cardiovascular: 0.5,
      muscular_lower: 0.5,
      muscular_upper: 0.5,
      impact: 0,
      eccentric: 0,
      technical: 0,
    },
    intensity: "easy",
    heavyStrength: false,
    durationMin: 20,
    modality: "mobility",
    patterns: {},
    impactUnits: 0,
  },
  du_boxjump_metcon: {
    expectedCredits: { crossfit_exposure: 1, hi_conditioning: 1, power: 0.6 },
    loadVector: {
      cardiovascular: 8,
      muscular_lower: 6,
      muscular_upper: 3,
      impact: 8,
      eccentric: 5,
      technical: 3,
    },
    intensity: "hard",
    heavyStrength: false,
    durationMin: 50,
    modality: "mixed_modal",
    patterns: { locomotion: 5, squat: 3 },
    impactUnits: 7,
  },
};

export function profileOfKind(kind: string): LoadProfile {
  const e = getCatalogEntry(kind);
  if (!e) throw new Error(`unknown catalog kind ${kind}`);
  return {
    expectedCredits: e.expectedCredits,
    loadVector: e.loadVector,
    intensity: e.intensity,
    heavyStrength: e.heavyStrength ?? false,
    durationMin: e.durationMin,
    modality: e.modality,
    patterns: e.patterns,
    impactUnits: e.impactUnits ?? 0,
  };
}

export function session(args: {
  id?: string;
  date: IsoDate;
  profile: LoadProfile | string;
  type?: WorkoutType;
  kind?: string;
  family?: string;
  hour?: number;
  rpe?: number | null;
  estimated?: boolean;
  funScore?: number | null;
}): HistorySession {
  const profile =
    typeof args.profile === "string"
      ? (PROFILES[args.profile] ?? profileOfKind(args.profile))
      : args.profile;
  const hour = args.hour ?? 18;
  const type: WorkoutType =
    args.type ??
    (profile.modality === "mixed_modal"
      ? "crossfit"
      : profile.modality === "strength" ||
          profile.modality === "weightlifting" ||
          profile.modality === "gymnastics"
        ? "strength"
        : profile.modality === "mobility"
          ? "mobility"
          : "cardio");
  const rpe =
    args.rpe === undefined
      ? profile.intensity === "hard"
        ? 8
        : profile.intensity === "moderate"
          ? 6.5
          : 4
      : args.rpe;
  return {
    id:
      args.id ??
      `${args.date}-${args.kind ?? (typeof args.profile === "string" ? args.profile : type)}`,
    date: args.date,
    endTime: `${args.date}T${String(hour + 1).padStart(2, "0")}:00:00Z`,
    type,
    kind: args.kind ?? (typeof args.profile === "string" ? args.profile : null),
    family: args.family ?? null,
    rpe,
    funScore: args.funScore ?? null,
    sessionRpeLoad: rpe != null ? Math.round(profile.durationMin * rpe) : null,
    estimated: args.estimated ?? false,
    ...profile,
  };
}

export function fixedClass(args: {
  id?: string;
  date: IsoDate;
  startMinute?: number;
  profile?: LoadProfile | string | null;
  wodStatus?: PlannedSession["wodStatus"];
  wodConfidence?: number | null;
  title?: string;
}): PlannedSession {
  const profile =
    args.profile === undefined || args.profile === null
      ? null
      : typeof args.profile === "string"
        ? (PROFILES[args.profile] ?? profileOfKind(args.profile))
        : args.profile;
  return {
    id: args.id ?? `class-${args.date}`,
    date: args.date,
    type: "crossfit",
    title: args.title ?? "CROSSFIT — 18:30",
    startMinute: args.startMinute ?? 18 * 60 + 30,
    fixed: true,
    status: "planned",
    kind: "crossfit",
    family: "crossfit",
    profile,
    wodStatus: args.wodStatus ?? (profile ? "confirmed" : "none"),
    wodConfidence: args.wodConfidence ?? (profile ? 1 : null),
  };
}

export function plannedFree(args: {
  id?: string;
  date: IsoDate;
  kind: string;
  title?: string;
  startMinute?: number;
}): PlannedSession {
  const p = profileOfKind(args.kind);
  const e = getCatalogEntry(args.kind);
  return {
    id: args.id ?? `plan-${args.date}-${args.kind}`,
    date: args.date,
    type: e?.modality === "strength" ? "strength" : "cardio",
    title: args.title ?? e?.title ?? args.kind,
    startMinute: args.startMinute ?? null,
    fixed: false,
    status: "planned",
    kind: args.kind,
    family: e?.family ?? args.kind,
    profile: p,
    wodStatus: "none",
    wodConfidence: null,
  };
}

export interface ScenarioOptions {
  today?: IsoDate;
  hour?: number;
  history?: HistorySession[];
  planned?: PlannedSession[];
  readiness?: EngineInput["readiness"];
  intents?: UserIntent[];
  pain?: EngineInput["pain"];
  baselinePhase?: boolean;
  deload?: EngineInput["deload"];
  availability?: EngineInput["availability"];
  events?: EngineInput["events"];
  lastTestDates?: EngineInput["lastTestDates"];
  equipment?: EngineInput["profile"]["equipmentAvailable"];
  maxHard?: number;
  learned?: Record<string, number>;
}

/** Default: Thursday 2026-10-01 08:00, well-equipped athlete, good readiness, 28 days of moderate history unless given. */
export function scenario(o: ScenarioOptions = {}): EngineInput {
  const today = o.today ?? "2026-10-01";
  const hour = o.hour ?? 8;
  return {
    now: `${today}T${String(hour).padStart(2, "0")}:00:00Z`,
    today,
    profile: {
      goalWeights: { ...NICOLAS_GOALS },
      targets: deriveWeeklyTargets({
        goalWeights: NICOLAS_GOALS,
        maxHardSessionsPerWeek: o.maxHard ?? 3,
        deloadActive: o.deload?.active,
      }),
      baselinePhase: o.baselinePhase ?? false,
      maxHardSessionsPerWeek: o.maxHard ?? 3,
      weeklyHoursTarget: 8,
      preferences: { favouriteModalities: [], dislikedModalities: [] },
      equipmentAvailable: o.equipment ?? [
        "barbell",
        "rack",
        "bench",
        "pull_up_bar",
        "dumbbell",
        "kettlebell",
        "rower",
        "bike_erg",
        "ski_erg",
        "outdoor",
        "track",
        "road_bike",
        "bodyweight",
        "wall_ball",
        "box",
        "jump_rope",
        "sled",
        "rings",
      ],
    },
    history: o.history ?? [],
    planned: o.planned ?? [],
    readiness:
      o.readiness === undefined
        ? { band: "good", hasDeclared: true, hasMeasured: false, signals: [] }
        : o.readiness,
    pain: o.pain ?? [],
    intents: o.intents ?? [],
    availability: o.availability ?? null,
    athleteModel: buildAthleteModel(o.learned ?? {}, {
      meanWeeklyImpactIU: 15,
      meanDailyLoadAU: 400,
    }),
    deload: o.deload ?? null,
    events: o.events ?? [],
    lastTestDates: o.lastTestDates ?? {},
  };
}

/** A typical balanced 3-week history ending the day before `today` (for confidence and ledger realism). */
export function typicalHistory(today: IsoDate, weeks = 3): HistorySession[] {
  const out: HistorySession[] = [];
  for (let w = weeks; w >= 1; w--) {
    const monday = addDays(
      today,
      -7 * w - ((Date.parse(`${today}T00:00:00Z`) / 86_400_000 + 3) % 7),
    );
    out.push(
      session({ date: addDays(monday, 0), profile: "heavy_squat_wallballs", kind: "crossfit" }),
    );
    out.push(session({ date: addDays(monday, 1), profile: "easy_run_45", kind: "run_easy_45" }));
    out.push(
      session({ date: addDays(monday, 2), profile: "upper_strength", kind: "strength_upper" }),
    );
    out.push(session({ date: addDays(monday, 3), profile: "easy_bike_60", kind: "bike_easy_60" }));
    out.push(session({ date: addDays(monday, 4), profile: "deadlift_crossfit", kind: "crossfit" }));
    out.push(session({ date: addDays(monday, 5), profile: "run_intervals", kind: "run_vo2" }));
  }
  return out.filter((s) => s.date < today);
}

export const ZERO_LOAD: LoadVector = {
  cardiovascular: 0,
  muscular_lower: 0,
  muscular_upper: 0,
  impact: 0,
  eccentric: 0,
  technical: 0,
};
export { crossfitClassPrior };
