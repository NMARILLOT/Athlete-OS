import "server-only";
import { DEFAULT_GOALS } from "./engine-input";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { scoped } from "@/db/repo/scoped";
import {
  activities,
  activityLaps,
  activityStreams,
  aiInvocations,
  athleteModelParams,
  athleteProfiles,
  availabilityWindows,
  benchmarkResults,
  benchmarks,
  bodyCompositions,
  cardioWorkouts,
  clientEvents,
  coachSessions,
  computedMetrics,
  crossfitWorkouts,
  dailyReadiness,
  events,
  goals,
  hrZoneSets,
  integrations,
  painLogs,
  personalRecords,
  rawPayloads,
  recommendations,
  recoveryMetrics,
  strengthSets,
  syncJobs,
  testResults,
  trainingBlocks,
  travelPeriods,
  userIntents,
  userPreferences,
  users,
  weeklyStimulusTargets,
  wodInboxItems,
  workoutAnalyses,
  workoutExercises,
  workouts,
  type Facilities,
  type PreferredTrainingTimes,
} from "@/db/schema";
import type { BlockFocus, Equipment, GoalKey, Modality, PainLocation } from "@/domain/core";
import { addDays, type IsoDate } from "@/domain/core/dates";
import { getExercise } from "@/domain/exercises";
import type { CurrentUser } from "@/server/auth";
import { env } from "@/server/env";
import { ValidationError } from "@/server/errors";
import { flags, type FeatureFlags } from "@/server/flags";
import { log } from "@/server/logging";
import { garminProvider } from "@/server/providers/garmin";
import { localDate } from "@/server/time";

/**
 * Profile & onboarding service (spec §34–36, §71, §89–90, §101; ARCHITECTURE §3 route map).
 *
 * Everything the profile screens show is assembled by `getProfileView`; every write is a small,
 * idempotent upsert so onboarding steps can be revisited. Engine defaults (`DEFAULT_GOALS` in
 * engine-input.ts) are mirrored here so the screens display what the engine actually uses when
 * nothing is stored.
 */

// ---------------------------------------------------------------------------
// Goal vocabulary (French titles stored in `goals.title`)
// ---------------------------------------------------------------------------

export const LONG_GOAL_KEYS = [
  "health_longevity",
  "crossfit",
  "endurance",
  "strength",
  "physique",
  "fun",
] as const satisfies readonly GoalKey[];
export type LongGoalKey = (typeof LONG_GOAL_KEYS)[number];

export const MEDIUM_GOAL_KEYS = [
  "event_5k",
  "event_10k",
  "event_hyrox",
  "event_open",
  "event_trail",
  "skill_muscle_up",
  "skill_handstand_walk",
  "lift_clean",
  "lift_snatch",
  "zone2_capacity",
] as const satisfies readonly GoalKey[];
export type MediumGoalKey = (typeof MEDIUM_GOAL_KEYS)[number];

/** Engine defaults when nothing is stored (single source: DEFAULT_GOALS in engine-input.ts). */
export const DEFAULT_GOAL_WEIGHTS: Record<LongGoalKey, number> = Object.fromEntries(
  LONG_GOAL_KEYS.map((key) => [key, DEFAULT_GOALS[key] ?? 0.7]),
) as Record<LongGoalKey, number>;

/** Weight given to a medium-term goal when the athlete switches it on. */
export const DEFAULT_MEDIUM_GOAL_WEIGHT = 0.7;

export const GOAL_TITLE_FR: Record<GoalKey, string> = {
  health_longevity: "Santé & longévité",
  crossfit: "CrossFit",
  endurance: "Endurance",
  strength: "Force",
  physique: "Physique",
  fun: "Plaisir",
  event_5k: "Courir un 5 km",
  event_10k: "Courir un 10 km",
  event_hyrox: "Hyrox",
  event_open: "CrossFit Open",
  event_trail: "Trail",
  skill_muscle_up: "Muscle-up",
  skill_handstand_walk: "Handstand walk",
  lift_clean: "Clean",
  lift_snatch: "Snatch",
  zone2_capacity: "Capacité zone 2",
};

/** Lifts offered as declared 1RM during onboarding (spec §89 "niveau / PR"). */
export const ONBOARDING_PR_LIFTS = [
  "back_squat",
  "front_squat",
  "deadlift",
  "bench_press",
  "strict_press",
  "clean",
  "snatch",
] as const;

export const DEFAULT_WEEKLY_HOURS = 7;
export const DEFAULT_MAX_HARD_SESSIONS = 3;
export const BASELINE_PHASE_DAYS = 21;

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export interface ProfileGoalView {
  key: GoalKey;
  title: string;
  /** 0..1 */
  weight: number;
  active: boolean;
}

export interface ProfileBlockView {
  id: string;
  name: string;
  focus: BlockFocus;
  startsOn: string;
  endsOn: string | null;
  source: string;
  reason: string | null;
}

export interface ProfilePainView {
  id: string;
  location: PainLocation;
  side: string | null;
  intensity: number;
  status: string;
  reportedAt: string;
}

export interface AvailabilitySlotView {
  id: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
}

export interface DeclaredPrView {
  exerciseId: string;
  name: string;
  valueKg: number;
  reps: number | null;
  achievedAt: string;
}

export interface ProfileView {
  user: {
    id: string;
    email: string;
    displayName: string;
    timezone: string;
    onboardingCompletedAt: string | null;
  };
  profile: {
    weeklyHoursTarget: number;
    preferredTrainingTimes: PreferredTrainingTimes;
    equipment: Equipment[];
    facilities: Facilities;
    lthrManual: number | null;
    maxHrManual: number | null;
    restingHrManual: number | null;
    bodyweightKg: number | null;
    baselinePhaseUntil: string | null;
    /** True while the engine is in its conservative learning phase. */
    baselinePhase: boolean;
    /** True when no athlete_profiles row exists yet (defaults shown). */
    stored: boolean;
  };
  preferences: {
    barbellIncrementKg: number;
    dumbbellIncrementKg: number;
    machineIncrementKg: number;
    maxHardSessionsPerWeek: number;
    favouriteModalities: Modality[];
    dislikedModalities: Modality[];
    compositeScoreEnabled: boolean;
    stored: boolean;
  };
  goals: {
    long: ProfileGoalView[];
    medium: ProfileGoalView[];
    /** True when no goal row exists: the engine uses its documented defaults. */
    usingDefaults: boolean;
  };
  /** Active non-recovery block (the CURRENT FOCUS), if any. */
  block: ProfileBlockView | null;
  /** Active deload (focus = recovery, not ended, endsOn ≥ today), if any. */
  deload: ProfileBlockView | null;
  pains: ProfilePainView[];
  availability: AvailabilitySlotView[];
  declaredPrs: DeclaredPrView[];
  flags: FeatureFlags;
  integrations: {
    garmin: {
      provider: "mock" | "official";
      flag: boolean;
      /** What the selected provider reports (mock always says yes). */
      providerConnected: boolean;
      /** `integrations` row status for this user, if a row exists. */
      status: string | null;
      connectedAt: string | null;
      lastSyncAt: string | null;
    };
    bodyComp: { provider: "manual" | "withings" | "garmin"; flag: boolean };
    ai: { provider: "anthropic" | "mock"; coachFlag: boolean };
  };
  authMode: "local" | "supabase";
  today: IsoDate;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function toBlockView(b: typeof trainingBlocks.$inferSelect): ProfileBlockView {
  return {
    id: b.id,
    name: b.name,
    focus: b.focus,
    startsOn: b.startsOn,
    endsOn: b.endsOn,
    source: b.source,
    reason: b.reason,
  };
}

/** Blocks that are active on `today` (started, not ended, not expired), newest first. */
async function activeBlocks(db: Db, userId: string, today: IsoDate) {
  return db
    .select()
    .from(trainingBlocks)
    .where(
      and(
        eq(trainingBlocks.userId, userId),
        sql`${trainingBlocks.startsOn} <= ${today}`,
        sql`(${trainingBlocks.endsOn} is null or ${trainingBlocks.endsOn} >= ${today})`,
        isNull(trainingBlocks.endedBy),
      ),
    )
    .orderBy(desc(trainingBlocks.startsOn), desc(trainingBlocks.createdAt));
}

export async function getProfileView(
  db: Db,
  user: Pick<CurrentUser, "id" | "timezone">,
  opts: { today?: IsoDate; now?: Date } = {},
): Promise<ProfileView> {
  const userId = user.id;
  const now = opts.now ?? new Date();
  const today = opts.today ?? localDate(now, user.timezone);

  const [userRow] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!userRow) throw new ValidationError("Utilisateur introuvable");
  const [profile] = await db
    .select()
    .from(athleteProfiles)
    .where(eq(athleteProfiles.userId, userId))
    .limit(1);
  const [prefs] = await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  const goalRows = await db.select().from(goals).where(eq(goals.userId, userId));
  const blocks = await activeBlocks(db, userId, today);
  const painRows = await db
    .select()
    .from(painLogs)
    .where(and(eq(painLogs.userId, userId), inArray(painLogs.status, ["active", "improving"])))
    .orderBy(desc(painLogs.reportedAt));
  const windowRows = await db
    .select()
    .from(availabilityWindows)
    .where(
      and(
        eq(availabilityWindows.userId, userId),
        eq(availabilityWindows.source, "USER"),
        isNull(availabilityWindows.date),
        eq(availabilityWindows.kind, "available"),
      ),
    )
    .orderBy(asc(availabilityWindows.weekday), asc(availabilityWindows.startMinute));
  const prRows = await db
    .select()
    .from(personalRecords)
    .where(
      and(
        eq(personalRecords.userId, userId),
        eq(personalRecords.kind, "weight"),
        eq(personalRecords.source, "USER"),
        eq(personalRecords.superseded, false),
        isNull(personalRecords.workoutId),
      ),
    )
    .orderBy(asc(personalRecords.exerciseId));
  const [garminRow] = await db
    .select({
      status: integrations.status,
      connectedAt: integrations.connectedAt,
      lastSyncAt: integrations.lastSyncAt,
    })
    .from(integrations)
    .where(and(eq(integrations.userId, userId), eq(integrations.provider, "garmin")))
    .limit(1);

  const e = env();
  const f = flags();
  const garmin = garminProvider();
  let providerConnected = false;
  try {
    providerConnected = await garmin.isConnected(userId);
  } catch (err) {
    log.warn("profile.garmin_status_failed", {
      userId,
      provider: garmin.name,
      errorName: err instanceof Error ? err.name : typeof err,
    });
  }

  const longRows = new Map(
    goalRows.filter((g) => g.horizon === "long").map((g) => [g.key, g] as const),
  );
  const mediumRows = new Map(
    goalRows.filter((g) => g.horizon === "medium").map((g) => [g.key, g] as const),
  );
  const usingDefaults = goalRows.filter((g) => g.active).length === 0;

  return {
    user: {
      id: userRow.id,
      email: userRow.email,
      displayName: userRow.displayName,
      timezone: userRow.timezone,
      onboardingCompletedAt: iso(userRow.onboardingCompletedAt),
    },
    profile: {
      weeklyHoursTarget: profile?.weeklyHoursTarget ?? DEFAULT_WEEKLY_HOURS,
      preferredTrainingTimes: profile?.preferredTrainingTimes ?? {},
      equipment: (profile?.equipment ?? []) as Equipment[],
      facilities: profile?.facilities ?? {},
      lthrManual: profile?.lthrManual ?? null,
      maxHrManual: profile?.maxHrManual ?? null,
      restingHrManual: profile?.restingHrManual ?? null,
      bodyweightKg: profile?.bodyweightKg ?? null,
      baselinePhaseUntil: profile?.baselinePhaseUntil ?? null,
      baselinePhase: profile?.baselinePhaseUntil
        ? profile.baselinePhaseUntil >= today
        : !userRow.onboardingCompletedAt,
      stored: Boolean(profile),
    },
    preferences: {
      barbellIncrementKg: prefs?.barbellIncrementKg ?? 2.5,
      dumbbellIncrementKg: prefs?.dumbbellIncrementKg ?? 2,
      machineIncrementKg: prefs?.machineIncrementKg ?? 2.5,
      maxHardSessionsPerWeek: prefs?.maxHardSessionsPerWeek ?? DEFAULT_MAX_HARD_SESSIONS,
      favouriteModalities: prefs?.favouriteModalities ?? [],
      dislikedModalities: prefs?.dislikedModalities ?? [],
      compositeScoreEnabled: prefs?.compositeScoreEnabled ?? false,
      stored: Boolean(prefs),
    },
    goals: {
      long: LONG_GOAL_KEYS.map((key) => {
        const row = longRows.get(key);
        return {
          key,
          title: row?.title ?? GOAL_TITLE_FR[key],
          weight: row ? row.weight : DEFAULT_GOAL_WEIGHTS[key],
          active: row ? row.active : true,
        };
      }),
      medium: MEDIUM_GOAL_KEYS.map((key) => {
        const row = mediumRows.get(key);
        return {
          key,
          title: row?.title ?? GOAL_TITLE_FR[key],
          weight: row ? row.weight : DEFAULT_MEDIUM_GOAL_WEIGHT,
          active: row ? row.active : false,
        };
      }),
      usingDefaults,
    },
    block: (() => {
      const b = blocks.find((x) => x.focus !== "recovery");
      return b ? toBlockView(b) : null;
    })(),
    deload: (() => {
      const b = blocks.find((x) => x.focus === "recovery");
      return b ? toBlockView(b) : null;
    })(),
    pains: painRows.map((p) => ({
      id: p.id,
      location: p.location,
      side: p.side,
      intensity: p.intensity,
      status: p.status,
      reportedAt: p.reportedAt.toISOString(),
    })),
    availability: windowRows
      .filter((w): w is typeof w & { weekday: number } => w.weekday != null)
      .map((w) => ({
        id: w.id,
        weekday: w.weekday,
        startMinute: w.startMinute,
        endMinute: w.endMinute,
      })),
    declaredPrs: prRows
      .filter((r): r is typeof r & { exerciseId: string } => r.exerciseId != null)
      .map((r) => ({
        exerciseId: r.exerciseId,
        name: getExercise(r.exerciseId)?.name ?? r.exerciseId,
        valueKg: r.value,
        reps: r.reps,
        achievedAt: r.achievedAt.toISOString(),
      })),
    flags: f,
    integrations: {
      garmin: {
        provider: e.GARMIN_PROVIDER,
        flag: f.garmin,
        providerConnected,
        status: garminRow?.status ?? null,
        connectedAt: iso(garminRow?.connectedAt),
        lastSyncAt: iso(garminRow?.lastSyncAt),
      },
      bodyComp: { provider: e.BODYCOMP_PROVIDER, flag: f.bodyComp },
      ai: { provider: e.AI_PROVIDER, coachFlag: f.aiCoach },
    },
    authMode: e.AUTH_MODE,
    today,
  };
}

// ---------------------------------------------------------------------------
// Identity, profile basics, preferences
// ---------------------------------------------------------------------------

export interface IdentityInput {
  displayName?: string;
  timezone?: string;
}

export async function updateIdentity(db: Db, userId: string, input: IdentityInput): Promise<void> {
  const set: Partial<typeof users.$inferInsert> = {};
  if (input.displayName !== undefined) set.displayName = input.displayName.trim().slice(0, 80);
  if (input.timezone !== undefined) {
    if (!isValidTimeZone(input.timezone)) throw new ValidationError("Fuseau horaire invalide");
    set.timezone = input.timezone;
  }
  if (Object.keys(set).length === 0) return;
  await db.update(users).set(set).where(eq(users.id, userId));
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface ProfileBasicsInput {
  weeklyHoursTarget?: number;
  preferredTrainingTimes?: PreferredTrainingTimes;
  equipment?: Equipment[];
  facilities?: Facilities;
  lthrManual?: number | null;
  maxHrManual?: number | null;
  restingHrManual?: number | null;
  bodyweightKg?: number | null;
}

/** Upsert the 1:1 athlete profile; only the provided keys change (idempotent per step). */
export async function upsertProfileBasics(
  db: Db,
  userId: string,
  input: ProfileBasicsInput,
): Promise<void> {
  const set: Partial<typeof athleteProfiles.$inferInsert> = {};
  if (input.weeklyHoursTarget !== undefined) {
    if (input.weeklyHoursTarget < 1 || input.weeklyHoursTarget > 30)
      throw new ValidationError("Heures hebdomadaires hors limites");
    set.weeklyHoursTarget = input.weeklyHoursTarget;
  }
  if (input.preferredTrainingTimes !== undefined)
    set.preferredTrainingTimes = input.preferredTrainingTimes;
  if (input.equipment !== undefined) set.equipment = [...new Set(input.equipment)];
  if (input.facilities !== undefined) set.facilities = input.facilities;
  if (input.lthrManual !== undefined) set.lthrManual = input.lthrManual;
  if (input.maxHrManual !== undefined) set.maxHrManual = input.maxHrManual;
  if (input.restingHrManual !== undefined) set.restingHrManual = input.restingHrManual;
  if (input.bodyweightKg !== undefined) set.bodyweightKg = input.bodyweightKg;
  await db
    .insert(athleteProfiles)
    .values({ userId, ...set })
    .onConflictDoUpdate({
      target: athleteProfiles.userId,
      set: Object.keys(set).length ? set : { updatedAt: new Date() },
    });
}

export interface PreferencesInput {
  barbellIncrementKg?: number;
  dumbbellIncrementKg?: number;
  machineIncrementKg?: number;
  maxHardSessionsPerWeek?: number;
  favouriteModalities?: Modality[];
  dislikedModalities?: Modality[];
  compositeScoreEnabled?: boolean;
}

export async function upsertPreferences(
  db: Db,
  userId: string,
  input: PreferencesInput,
): Promise<void> {
  const set: Partial<typeof userPreferences.$inferInsert> = {};
  for (const k of ["barbellIncrementKg", "dumbbellIncrementKg", "machineIncrementKg"] as const) {
    const v = input[k];
    if (v !== undefined) {
      if (!(v > 0 && v <= 20)) throw new ValidationError("Incrément invalide");
      set[k] = v;
    }
  }
  if (input.maxHardSessionsPerWeek !== undefined) {
    if (input.maxHardSessionsPerWeek < 0 || input.maxHardSessionsPerWeek > 7)
      throw new ValidationError("Nombre de séances dures invalide");
    set.maxHardSessionsPerWeek = input.maxHardSessionsPerWeek;
  }
  if (input.favouriteModalities !== undefined)
    set.favouriteModalities = [...new Set(input.favouriteModalities)];
  if (input.dislikedModalities !== undefined)
    set.dislikedModalities = [...new Set(input.dislikedModalities)];
  if (input.compositeScoreEnabled !== undefined)
    set.compositeScoreEnabled = input.compositeScoreEnabled;
  await db
    .insert(userPreferences)
    .values({ userId, ...set })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: Object.keys(set).length ? set : { updatedAt: new Date() },
    });
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
  if (!Number.isFinite(v)) throw new ValidationError("Poids d'objectif invalide");
  return Math.min(1, Math.max(0, Math.round(v * 100) / 100));
}

/**
 * Upsert the long-term goal rows (horizon `long`). The first write materialises all six keys
 * (engine defaults for the ones not provided) so the engine never falls back to its defaults
 * for some keys and stored values for others.
 */
export async function setGoalWeights(
  db: Db,
  userId: string,
  weights: Partial<Record<GoalKey, number>>,
): Promise<void> {
  const existing = await db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.horizon, "long")));
  const byKey = new Map(existing.map((g) => [g.key, g] as const));
  const longKeys = new Set<GoalKey>(LONG_GOAL_KEYS);
  for (const key of Object.keys(weights) as GoalKey[]) {
    if (!longKeys.has(key)) throw new ValidationError(`Objectif long terme inconnu : ${key}`);
  }
  await db.transaction(async (tx) => {
    for (const key of LONG_GOAL_KEYS) {
      const provided = weights[key];
      const row = byKey.get(key);
      if (row) {
        if (provided === undefined) continue;
        await tx
          .update(goals)
          .set({ weight: clamp01(provided), active: true, title: row.title || GOAL_TITLE_FR[key] })
          .where(and(eq(goals.id, row.id), eq(goals.userId, userId)));
      } else {
        await tx.insert(goals).values({
          userId,
          horizon: "long",
          key,
          title: GOAL_TITLE_FR[key],
          weight: clamp01(provided ?? DEFAULT_GOAL_WEIGHTS[key]),
          active: true,
        });
      }
    }
  });
}

/**
 * Switch medium-term goals on/off (horizon `medium`). Selected keys become active rows (default
 * weight unless already stored); unselected existing rows are deactivated, never deleted.
 */
export async function setMediumGoals(
  db: Db,
  userId: string,
  selected: GoalKey[],
  weights: Partial<Record<GoalKey, number>> = {},
): Promise<void> {
  const mediumKeys = new Set<GoalKey>(MEDIUM_GOAL_KEYS);
  const wanted = new Set(selected);
  for (const key of wanted) {
    if (!mediumKeys.has(key)) throw new ValidationError(`Objectif moyen terme inconnu : ${key}`);
  }
  // Long-term rows must exist first, otherwise engine-input would read only the medium goals.
  const longCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.horizon, "long")));
  if ((longCount[0]?.n ?? 0) === 0) await setGoalWeights(db, userId, {});

  const existing = await db
    .select()
    .from(goals)
    .where(and(eq(goals.userId, userId), eq(goals.horizon, "medium")));
  const byKey = new Map(existing.map((g) => [g.key, g] as const));
  await db.transaction(async (tx) => {
    for (const key of MEDIUM_GOAL_KEYS) {
      const row = byKey.get(key);
      const active = wanted.has(key);
      const w = weights[key];
      if (row) {
        if (row.active === active && w === undefined) continue;
        await tx
          .update(goals)
          .set({ active, ...(w !== undefined ? { weight: clamp01(w) } : {}) })
          .where(and(eq(goals.id, row.id), eq(goals.userId, userId)));
      } else if (active) {
        await tx.insert(goals).values({
          userId,
          horizon: "medium",
          key,
          title: GOAL_TITLE_FR[key],
          weight: clamp01(w ?? DEFAULT_MEDIUM_GOAL_WEIGHT),
          active: true,
        });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export interface AvailabilitySlotInput {
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  startMinute: number;
  endMinute: number;
}

/** Replace the recurring USER availability windows (dated and provider windows are untouched). */
export async function setAvailability(
  db: Db,
  userId: string,
  slots: AvailabilitySlotInput[],
): Promise<void> {
  for (const s of slots) {
    if (!Number.isInteger(s.weekday) || s.weekday < 0 || s.weekday > 6)
      throw new ValidationError("Jour invalide");
    if (
      !Number.isInteger(s.startMinute) ||
      !Number.isInteger(s.endMinute) ||
      s.startMinute < 0 ||
      s.endMinute > 1440 ||
      s.startMinute >= s.endMinute
    )
      throw new ValidationError("Créneau invalide");
  }
  const dedup = new Map<string, AvailabilitySlotInput>();
  for (const s of slots) dedup.set(`${s.weekday}:${s.startMinute}:${s.endMinute}`, s);
  await db.transaction(async (tx) => {
    await tx
      .delete(availabilityWindows)
      .where(
        and(
          eq(availabilityWindows.userId, userId),
          eq(availabilityWindows.source, "USER"),
          isNull(availabilityWindows.date),
        ),
      );
    if (dedup.size) {
      await tx.insert(availabilityWindows).values(
        [...dedup.values()].map((s) => ({
          userId,
          weekday: s.weekday,
          date: null,
          startMinute: s.startMinute,
          endMinute: s.endMinute,
          kind: "available",
          source: "USER",
        })),
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Declared PRs
// ---------------------------------------------------------------------------

export interface DeclaredPrInput {
  exerciseId: string;
  weightKg: number;
  reps?: number;
}

/**
 * Declared 1RM (spec §89 "niveau / PR"): `personal_records` kind `weight`, source `USER`,
 * `estimated = false`. Unknown catalog ids are ignored; re-declaring updates the row in place
 * (natural key: user, kind, exercise, no workout/activity) and keeps the previous value.
 * Returns the ids actually written.
 */
export async function seedDeclaredPrs(
  db: Db,
  userId: string,
  prs: DeclaredPrInput[],
): Promise<string[]> {
  const written: string[] = [];
  const now = new Date();
  await db.transaction(async (tx) => {
    for (const pr of prs) {
      if (!getExercise(pr.exerciseId)) continue;
      if (!(Number.isFinite(pr.weightKg) && pr.weightKg > 0 && pr.weightKg < 500)) continue;
      const reps = pr.reps && pr.reps > 0 ? Math.round(pr.reps) : 1;
      const value = Math.round(pr.weightKg * 4) / 4;
      const [existing] = await tx
        .select()
        .from(personalRecords)
        .where(
          and(
            eq(personalRecords.userId, userId),
            eq(personalRecords.kind, "weight"),
            eq(personalRecords.exerciseId, pr.exerciseId),
            isNull(personalRecords.benchmarkId),
            isNull(personalRecords.distanceKey),
            isNull(personalRecords.workoutId),
            isNull(personalRecords.activityId),
            isNull(personalRecords.algorithmVersion),
          ),
        )
        .limit(1);
      if (existing) {
        if (existing.value === value && existing.reps === reps) {
          written.push(pr.exerciseId);
          continue;
        }
        await tx
          .update(personalRecords)
          .set({
            value,
            reps,
            unit: "kg",
            achievedAt: now,
            source: "USER",
            estimated: false,
            superseded: false,
            previousValue: existing.value,
          })
          .where(and(eq(personalRecords.id, existing.id), eq(personalRecords.userId, userId)));
      } else {
        await tx.insert(personalRecords).values({
          userId,
          kind: "weight",
          exerciseId: pr.exerciseId,
          value,
          unit: "kg",
          reps,
          achievedAt: now,
          source: "USER",
          estimated: false,
        });
      }
      written.push(pr.exerciseId);
    }
  });
  return written;
}

// ---------------------------------------------------------------------------
// Onboarding completion, blocks, deload
// ---------------------------------------------------------------------------

/**
 * Mark onboarding as completed and open the 21-day baseline phase (spec §90). Idempotent: a
 * re-run of the onboarding keeps the original completion date and does not restart a baseline
 * phase the engine has already gone through.
 */
export async function completeOnboarding(db: Db, userId: string, today: IsoDate): Promise<void> {
  const [userRow] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!userRow) throw new ValidationError("Utilisateur introuvable");
  if (!userRow.onboardingCompletedAt) {
    await db
      .update(users)
      .set({ onboardingCompletedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.onboardingCompletedAt)));
  }
  const [profile] = await db
    .select({ baselinePhaseUntil: athleteProfiles.baselinePhaseUntil })
    .from(athleteProfiles)
    .where(eq(athleteProfiles.userId, userId))
    .limit(1);
  const until = addDays(today, BASELINE_PHASE_DAYS);
  if (!profile) {
    await db
      .insert(athleteProfiles)
      .values({ userId, baselinePhaseUntil: until })
      .onConflictDoNothing({ target: athleteProfiles.userId });
  } else if (!profile.baselinePhaseUntil) {
    await db
      .update(athleteProfiles)
      .set({ baselinePhaseUntil: until })
      .where(eq(athleteProfiles.userId, userId));
  }
  log.info("onboarding.completed", { userId, date: today });
}

export interface StartDeloadInput {
  today: IsoDate;
  /** Deload length in days (1..21); default 7. */
  days?: number;
  reason?: string;
}

/** Start a user deload: a `focus = recovery` training block (spec §42). Idempotent while one is active. */
export async function startDeload(
  db: Db,
  userId: string,
  input: StartDeloadInput,
): Promise<ProfileBlockView> {
  const days = Math.round(input.days ?? 7);
  if (days < 1 || days > 21) throw new ValidationError("Durée de deload invalide");
  const current = (await activeBlocks(db, userId, input.today)).find((b) => b.focus === "recovery");
  if (current) return toBlockView(current);
  const [row] = await db
    .insert(trainingBlocks)
    .values({
      userId,
      name: "Deload",
      focus: "recovery",
      startsOn: input.today,
      endsOn: addDays(input.today, days - 1),
      source: "USER",
      reason: input.reason?.trim().slice(0, 200) || "Deload déclaré",
    })
    .returning();
  if (!row) throw new Error("training_blocks insert returned no row");
  log.info("deload.started", { userId, date: input.today, count: days });
  return toBlockView(row);
}

/** End the active user/engine deload (`endedBy = USER`). No-op when none is active. */
export async function endDeload(db: Db, userId: string, today?: IsoDate): Promise<boolean> {
  const where = and(
    eq(trainingBlocks.userId, userId),
    eq(trainingBlocks.focus, "recovery"),
    isNull(trainingBlocks.endedBy),
    today
      ? sql`(${trainingBlocks.endsOn} is null or ${trainingBlocks.endsOn} >= ${today})`
      : undefined,
  );
  const rows = await db.update(trainingBlocks).set({ endedBy: "USER" }).where(where).returning({
    id: trainingBlocks.id,
  });
  if (rows.length) log.info("deload.ended", { userId, count: rows.length });
  return rows.length > 0;
}

export interface SetFocusBlockInput {
  focus: Exclude<BlockFocus, "recovery">;
  name?: string;
  today: IsoDate;
}

/** Change the CURRENT FOCUS: end the active non-recovery block and open a new one (spec §36). */
export async function setFocusBlock(
  db: Db,
  userId: string,
  input: SetFocusBlockInput,
): Promise<ProfileBlockView> {
  if ((input.focus as BlockFocus) === "recovery")
    throw new ValidationError("Utilise startDeload pour un bloc de récupération");
  const name = input.name?.trim().slice(0, 80) || defaultBlockName(input.focus);
  return db.transaction(async (tx) => {
    const current = (await activeBlocks(tx, userId, input.today)).filter(
      (b) => b.focus !== "recovery",
    );
    for (const b of current) {
      await tx
        .update(trainingBlocks)
        .set({ endedBy: "USER" })
        .where(and(eq(trainingBlocks.id, b.id), eq(trainingBlocks.userId, userId)));
    }
    const [row] = await tx
      .insert(trainingBlocks)
      .values({
        userId,
        name,
        focus: input.focus,
        startsOn: input.today,
        endsOn: null,
        source: "USER",
      })
      .returning();
    if (!row) throw new Error("training_blocks insert returned no row");
    log.info("block.started", { userId, date: input.today, kind: input.focus });
    return toBlockView(row);
  });
}

function defaultBlockName(focus: BlockFocus): string {
  switch (focus) {
    case "base":
      return "Base aérobie + force";
    case "build":
      return "Construction";
    case "performance":
      return "Performance";
    case "recovery":
      return "Deload";
    default:
      return "Bloc libre";
  }
}

// ---------------------------------------------------------------------------
// Privacy: export & delete (spec §71, ARCHITECTURE §7)
// ---------------------------------------------------------------------------

export const EXPORT_FORMAT_VERSION = "athlete-os-export-v1" as const;

export interface UserDataExport {
  format: typeof EXPORT_FORMAT_VERSION;
  exportedAt: string;
  user: {
    id: string;
    email: string;
    displayName: string;
    timezone: string;
    onboardingCompletedAt: string | null;
    createdAt: string;
  };
  tables: Record<string, unknown[]>;
}

/**
 * Every user-owned table for this user as plain JSON (Dates → ISO strings). Secrets are never
 * exported: `integrations.credentials_encrypted` is omitted.
 */
export async function exportUserData(db: Db, userId: string): Promise<UserDataExport> {
  const [userRow] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!userRow) throw new ValidationError("Utilisateur introuvable");
  const s = scoped(db, userId);
  const tables: Record<string, unknown[]> = {
    athlete_profiles: await s.select(athleteProfiles),
    user_preferences: await s.select(userPreferences),
    goals: await s.select(goals),
    training_blocks: await s.select(trainingBlocks),
    workouts: await s.select(workouts),
    workout_exercises: await s.select(workoutExercises),
    strength_sets: await s.select(strengthSets),
    cardio_workouts: await s.select(cardioWorkouts),
    crossfit_workouts: await s.select(crossfitWorkouts),
    coach_sessions: await s.select(coachSessions),
    workout_analyses: await s.select(workoutAnalyses),
    raw_payloads: await s.select(rawPayloads),
    activities: await s.select(activities),
    activity_laps: await s.select(activityLaps),
    activity_streams: await s.select(activityStreams),
    daily_readiness: await s.select(dailyReadiness),
    recovery_metrics: await s.select(recoveryMetrics),
    body_compositions: await s.select(bodyCompositions),
    pain_logs: await s.select(painLogs),
    personal_records: await s.select(personalRecords),
    benchmark_results: await s.select(benchmarkResults),
    test_results: await s.select(testResults),
    benchmarks: await db.select().from(benchmarks).where(eq(benchmarks.userId, userId)),
    weekly_stimulus_targets: await s.select(weeklyStimulusTargets),
    recommendations: await s.select(recommendations),
    user_intents: await s.select(userIntents),
    computed_metrics: await s.select(computedMetrics),
    hr_zone_sets: await s.select(hrZoneSets),
    athlete_model_params: await s.select(athleteModelParams),
    availability_windows: await s.select(availabilityWindows),
    events: await s.select(events),
    travel_periods: await s.select(travelPeriods),
    wod_inbox_items: await s.select(wodInboxItems),
    ai_invocations: await s.select(aiInvocations),
    integrations: await db
      .select({
        id: integrations.id,
        provider: integrations.provider,
        status: integrations.status,
        externalUserId: integrations.externalUserId,
        scopes: integrations.scopes,
        connectedAt: integrations.connectedAt,
        lastSyncAt: integrations.lastSyncAt,
        lastError: integrations.lastError,
        createdAt: integrations.createdAt,
        updatedAt: integrations.updatedAt,
      })
      .from(integrations)
      .where(eq(integrations.userId, userId)),
    sync_jobs: await s.select(syncJobs),
    client_events: await s.select(clientEvents),
  };
  const out: UserDataExport = {
    format: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    user: {
      id: userRow.id,
      email: userRow.email,
      displayName: userRow.displayName,
      timezone: userRow.timezone,
      onboardingCompletedAt: iso(userRow.onboardingCompletedAt),
      createdAt: userRow.createdAt.toISOString(),
    },
    tables,
  };
  // Plain JSON only (Date → ISO string, no Buffers/undefined) so the client can download it as-is.
  const plain = JSON.parse(JSON.stringify(out)) as UserDataExport;
  log.info("privacy.exported", {
    userId,
    count: Object.values(tables).reduce((n, rows) => n + rows.length, 0),
  });
  return plain;
}

/** Delete the account row: every user-owned table cascades (`user_id` FK ON DELETE CASCADE). */
export async function deleteUserData(db: Db, userId: string): Promise<void> {
  await db.delete(users).where(eq(users.id, userId));
  log.info("privacy.deleted", { userId });
}
