import "server-only";
import { and, asc, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Db } from "@/db/client";
import {
  activities,
  activityLaps,
  activityStreams,
  athleteProfiles,
  cardioWorkouts,
  computedMetrics,
  hrZoneSets,
  personalRecords,
  rawPayloads,
  testResults,
  workoutAnalyses,
  workouts,
  type ActivityStream,
  type MetricInputs,
} from "@/db/schema";
import {
  CARDIO_BUILDER_ALGORITHM_VERSION,
  MIN_MOVING_SPEED_MPS,
  RUNNING_DYNAMICS_ALGORITHM_VERSION,
  aerobicDecoupling,
  classifyComparableGroup,
  efficiencyFactorForActivity,
  expectedLoadProfile,
  runningDynamicsSummary,
  selectZoneSet,
  timeInZones,
  zoneForHr,
  zonesFromLthr,
  type CardioTarget,
  type CardioWorkoutSpec,
  type DecouplingSample,
  type HrZone,
  type HrZoneMethod,
  type HrZoneSet,
  type RunningDynamicsSample,
  type TimeInZones,
} from "@/domain/cardio";
import type { Confidence, DataSource, IntensityBand, Modality, WorkoutStatus } from "@/domain/core";
import type { IsoDate, IsoDateTime } from "@/domain/core/dates";
import type { LoadProfile } from "@/domain/engine";
import { ACTUAL_SCALING_VERSION, impactUnits, scaleTemplateLoadToActual } from "@/domain/load";
import { AppError } from "@/server/errors";
import { FIT_PARSER_VERSION, parseFit, type ParsedFit } from "@/server/fit/parser";
import { FeatureDisabledError, flags } from "@/server/flags";
import { log } from "@/server/logging";
import {
  garminProvider,
  type GarminActivityDetails,
  type GarminProvider,
} from "@/server/providers/garmin";
import { analysisRowFromProfile } from "@/server/services/workout.service";
import { localDate as localDateOf, tzOffsetMinutes } from "@/server/time";

/**
 * Activities — one import pipeline for FIT files and the Garmin provider (spec §13–15, §17, §29,
 * §30, §58, §68–70, §72–74; ADR-010):
 *
 *   store raw → dedupe (`raw_payloads.dedupe_key`) → normalise (`activities` upsert by fingerprint)
 *   → laps + streams (nulls kept, never invented) → versioned zones → time in zones → comparable
 *   group → versioned computed metrics → link / create the workout → PR detection.
 *
 * Everything is idempotent: the same file or the same Garmin activity imported twice is reported
 * as a duplicate and changes nothing; the same activity coming from both sources is merged on its
 * fingerprint (Garmin fields win, the original raw payload reference is kept).
 */
export const GARMIN_IMPORT_VERSION = "garmin_import_v1" as const;
export const RUN_PR_ALGORITHM_VERSION = "run_pr_prorata_v1" as const;
export const ACTIVITY_WORKOUT_ALGORITHM_VERSION = `${CARDIO_BUILDER_ALGORITHM_VERSION}+activity_v1`;
/** Streams are downsampled to at most this many points for the charts. */
export const MAX_CHART_POINTS = 600;

export type ActivityProvider = "garmin" | "fit_import";

export interface ImportUser {
  id: string;
  timezone: string;
}

export interface ImportMeta {
  provider: ActivityProvider;
  /** `fit:<sha256>` / `garmin:activity:<externalId>` — unique per user (raw_payloads). */
  dedupeKey: string;
  parserVersion: string;
  /** `raw_payloads.kind` (`fit_activity`, `activity`). */
  rawKind: string;
}

export interface ImportResult {
  activityId: string;
  workoutId: string | null;
  /** The very same payload was already imported: nothing changed. */
  duplicate: boolean;
  /** Another payload of the same activity existed: rows were merged on the fingerprint. */
  merged: boolean;
  /** French sentences, e.g. "Nouveau record 5 km : 24:31". */
  prs: string[];
}

export interface FitImportResult extends ImportResult {
  warnings: string[];
}

export interface GarminSyncResult {
  imported: number;
  duplicates: number;
  prs: string[];
}

/** Garmin dependencies, injectable so tests can swap the provider or the flag. */
export interface GarminSyncContext {
  enabled: boolean;
  provider: GarminProvider;
}

function defaultGarminContext(): GarminSyncContext {
  return { enabled: flags().garmin, provider: garminProvider() };
}

/** A FIT file the parser cannot read (HTTP 400 — the parser's own message is safe to show). */
export class InvalidFitError extends AppError {
  constructor(message: string) {
    super(message, "INVALID_FIT", 400);
    this.name = "InvalidFitError";
  }
}

// ---------------------------------------------------------------------------
// Sport → modality / venue / French title
// ---------------------------------------------------------------------------

const SPORT_MODALITY: Record<string, Modality> = {
  running: "running",
  trail_running: "running",
  track_running: "running",
  cycling: "bike",
  e_biking: "bike",
  rowing: "row",
  walking: "walking",
  hiking: "walking",
  swimming: "swimming",
  cross_country_skiing: "ski",
};

const SUB_SPORT_MODALITY: Record<string, Modality> = {
  treadmill: "running",
  indoor_running: "running",
  indoor_cycling: "bike",
  spin: "bike",
  indoor_rowing: "row",
  ski_erg: "ski",
  indoor_skiing: "ski",
  indoor_walking: "walking",
  lap_swimming: "swimming",
};

const INDOOR_SUB_SPORTS = new Set([
  "indoor_cycling",
  "spin",
  "virtual_activity",
  "indoor_rowing",
  "treadmill",
  "indoor_running",
  "indoor_walking",
  "ski_erg",
  "indoor_skiing",
  "elliptical",
  "stair_climbing",
]);

/** Modalities for which an unmatched activity becomes a done cardio workout. */
const ENDURANCE_MODALITIES: readonly Modality[] = [
  "running",
  "bike",
  "row",
  "ski",
  "walking",
  "swimming",
];

const MODALITY_FR: Record<Modality, string> = {
  running: "Course",
  bike: "Vélo",
  row: "Rameur",
  ski: "SkiErg",
  swimming: "Natation",
  walking: "Marche",
  strength: "Force",
  gymnastics: "Gymnastique",
  weightlifting: "Haltéro",
  mixed_modal: "Mixte",
  mobility: "Mobilité",
  other: "Activité",
};

/** FIT / Garmin sport + sub-sport → domain modality (`other` when unknown — never guessed). */
export function modalityForSport(sport: string, subSport?: string | null): Modality {
  const s = sport.toLowerCase();
  const sub = (subSport ?? "").toLowerCase();
  return SPORT_MODALITY[s] ?? SUB_SPORT_MODALITY[sub] ?? "other";
}

/** Venue from the sub-sport; null when the source did not say (comparable groups ignore it then). */
export function indoorForSubSport(subSport?: string | null): boolean | null {
  if (!subSport) return null;
  return INDOOR_SUB_SPORTS.has(subSport.toLowerCase());
}

/** "Course — 8.2 km", "Vélo — 45 min", "Trail — 12.4 km". */
export function activityTitle(
  sport: string,
  subSport: string | null | undefined,
  distanceM: number | null | undefined,
  durationSec: number,
): string {
  const modality = modalityForSport(sport, subSport);
  const label = sport.toLowerCase() === "trail_running" ? "Trail" : MODALITY_FR[modality];
  const extent =
    distanceM != null && distanceM >= 1000
      ? `${(distanceM / 1000).toFixed(1)} km`
      : `${Math.max(1, Math.round(durationSec / 60))} min`;
  return `${label} — ${extent}`;
}

/** Modality guessed from a planned workout title (used only when `cardio_workouts.modality` is absent). */
function guessModalityFromTitle(title: string): Modality {
  const t = title.toLowerCase();
  if (/(vélo|velo|bike|cycl|spin)/.test(t)) return "bike";
  if (/(rameur|row)/.test(t)) return "row";
  if (/ski/.test(t)) return "ski";
  if (/(marche|walk|rando)/.test(t)) return "walking";
  if (/(nage|natation|swim)/.test(t)) return "swimming";
  if (/(course|footing|run|trail|jog|sortie|tempo|seuil|vo2|fractionn|lignes droites)/.test(t))
    return "running";
  return "other";
}

function intensityFromZone(zone: number): IntensityBand {
  if (zone >= 4) return "hard";
  if (zone === 3) return "moderate";
  return "easy";
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** "24:31" / "1:42:05". */
function clock(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

const isPositive = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

type StreamMap = Partial<Record<ActivityStream, Array<number | null>>>;

function hasValues(values: Array<number | null> | undefined): values is Array<number | null> {
  return Array.isArray(values) && values.some((v) => v != null);
}

/**
 * Streams present in the source only; `pace` is derived from `speed` (sec/km, null when the
 * athlete is not moving, < 0.5 m/s). A series with no value at all is treated as absent.
 */
function buildStreams(s: GarminActivityDetails["streams"]): StreamMap {
  const out: StreamMap = {};
  if (hasValues(s.hr)) out.hr = s.hr;
  if (hasValues(s.speedMps)) {
    out.speed = s.speedMps;
    out.pace = s.speedMps.map((v) =>
      v != null && Number.isFinite(v) && v >= MIN_MOVING_SPEED_MPS ? Math.round(1000 / v) : null,
    );
  }
  if (hasValues(s.powerW)) out.power = s.powerW;
  if (hasValues(s.cadence)) out.cadence = s.cadence;
  if (hasValues(s.altitudeM)) out.altitude = s.altitudeM;
  if (hasValues(s.distanceM)) out.distance = s.distanceM;
  if (hasValues(s.gctMs)) out.gct = s.gctMs;
  if (hasValues(s.verticalOscillationMm)) out.vo = s.verticalOscillationMm;
  if (hasValues(s.strideLengthM)) out.stride = s.strideLengthM;
  return out;
}

function decouplingSamples(streams: StreamMap, intervalSec: number): DecouplingSample[] {
  const hr = streams.hr;
  if (!hr) return [];
  return hr.map((h, i) => ({
    tSec: i * intervalSec,
    hrBpm: h,
    speedMps: streams.speed?.[i] ?? null,
    powerW: streams.power?.[i] ?? null,
  }));
}

function dynamicsSamples(streams: StreamMap): RunningDynamicsSample[] {
  if (!streams.gct && !streams.vo && !streams.stride) return [];
  const n = Math.max(
    streams.cadence?.length ?? 0,
    streams.gct?.length ?? 0,
    streams.vo?.length ?? 0,
    streams.stride?.length ?? 0,
  );
  return Array.from({ length: n }, (_, i) => ({
    cadence: streams.cadence?.[i] ?? null,
    strideLengthM: streams.stride?.[i] ?? null,
    gctMs: streams.gct?.[i] ?? null,
    verticalOscillationMm: streams.vo?.[i] ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Zones (spec §16 — versioned; a session keeps the set valid on its date)
// ---------------------------------------------------------------------------

type ZoneSetRow = typeof hrZoneSets.$inferSelect;

function toDomainZoneSet(row: ZoneSetRow): HrZoneSet {
  return {
    validFrom: row.validFrom,
    method: row.method,
    lthr: row.lthr,
    maxHr: row.maxHr,
    restingHr: row.restingHr,
    zones: row.zones,
    source: row.source,
    confidence: row.confidence,
  };
}

interface ResolvedZoneSet {
  id: string;
  set: HrZoneSet;
}

/**
 * `selectZoneSet` over the user's stored sets for the activity date; otherwise a set derived once
 * from the profile's manual LTHR (`zonesFromLthr`, source USER, persisted); null when nothing is
 * known (never 220 − age).
 */
async function resolveZoneSetForDate(
  db: Db,
  userId: string,
  date: IsoDate,
): Promise<ResolvedZoneSet | null> {
  const rows = await db
    .select()
    .from(hrZoneSets)
    .where(eq(hrZoneSets.userId, userId))
    .orderBy(asc(hrZoneSets.validFrom), asc(hrZoneSets.createdAt));
  const sets = rows.map((row) => ({ row, set: toDomainZoneSet(row) }));
  const selected = selectZoneSet(
    sets.map((s) => s.set),
    date,
  );
  if (selected) {
    const match = sets.find((s) => s.set === selected);
    if (match) return { id: match.row.id, set: match.set };
  }

  const [profile] = await db
    .select({ lthr: athleteProfiles.lthrManual })
    .from(athleteProfiles)
    .where(eq(athleteProfiles.userId, userId))
    .limit(1);
  if (profile?.lthr == null) return null;
  let derived: HrZoneSet;
  try {
    derived = zonesFromLthr(profile.lthr, date, "USER");
  } catch {
    // An implausible profile value must never break an import: no zones rather than wrong zones.
    return null;
  }
  const lthr = derived.lthr ?? profile.lthr;
  // One derived row per manual LTHR value, even when it was first derived for another date.
  const same = rows.find((r) => r.method === "lthr" && r.source === "USER" && r.lthr === lthr);
  if (same) return { id: same.id, set: toDomainZoneSet(same) };
  const [inserted] = await db
    .insert(hrZoneSets)
    .values({
      userId,
      validFrom: derived.validFrom,
      method: derived.method,
      lthr,
      maxHr: derived.maxHr ?? null,
      restingHr: derived.restingHr ?? null,
      zones: derived.zones,
      source: derived.source,
      confidence: derived.confidence,
    })
    .returning();
  if (!inserted) throw new Error("hr_zone_sets insert failed");
  return { id: inserted.id, set: toDomainZoneSet(inserted) };
}

// ---------------------------------------------------------------------------
// Computed metrics (versioned; supersede other versions, upsert the current one)
// ---------------------------------------------------------------------------

interface MetricDraft {
  metric: string;
  value: number;
  unit: string;
  algorithmVersion: string;
  inputs: MetricInputs;
}

function metricDrafts(input: {
  modality: Modality;
  avgSpeedMps: number | null;
  avgPowerW: number | null;
  avgHr: number | null;
  streams: StreamMap;
  intervalSec: number;
}): MetricDraft[] {
  const drafts: MetricDraft[] = [];
  const ef = efficiencyFactorForActivity(input);
  if (ef) {
    drafts.push({
      metric: "efficiency_factor",
      value: ef.ef,
      unit: ef.basis === "power" ? "W/bpm" : "m/min/bpm",
      algorithmVersion: ef.algorithmVersion,
      inputs: {
        basis: ef.basis,
        avgHr: input.avgHr,
        avgSpeedMps: input.avgSpeedMps,
        avgPowerW: input.avgPowerW,
      },
    });
  }
  const dec = aerobicDecoupling(decouplingSamples(input.streams, input.intervalSec));
  if (dec) {
    drafts.push({
      metric: "aerobic_decoupling",
      value: dec.decouplingPct,
      unit: "%",
      algorithmVersion: dec.algorithmVersion,
      inputs: {
        basis: dec.basis,
        firstHalfEf: dec.firstHalfEf,
        secondHalfEf: dec.secondHalfEf,
        sampleCount: dec.sampleCount,
      },
    });
  }
  if (input.modality === "running") {
    const rd = runningDynamicsSummary(dynamicsSamples(input.streams));
    if (rd) {
      const fields: Array<{ key: keyof typeof rd; metric: string; unit: string }> = [
        { key: "cadence", metric: "rd_cadence", unit: "spm" },
        { key: "strideLengthM", metric: "rd_stride_length", unit: "m" },
        { key: "gctMs", metric: "rd_gct", unit: "ms" },
        { key: "verticalOscillationMm", metric: "rd_vertical_oscillation", unit: "mm" },
        { key: "verticalRatio", metric: "rd_vertical_ratio", unit: "%" },
        { key: "gctBalance", metric: "rd_gct_balance", unit: "%" },
      ];
      for (const f of fields) {
        const v = rd[f.key];
        if (typeof v !== "number") continue;
        drafts.push({
          metric: f.metric,
          value: v,
          unit: f.unit,
          algorithmVersion: RUNNING_DYNAMICS_ALGORITHM_VERSION,
          inputs: { sampleCount: rd.sampleCount },
        });
      }
    }
  }
  return drafts;
}

async function writeMetrics(
  db: Db,
  userId: string,
  activityId: string,
  date: IsoDate,
  drafts: MetricDraft[],
): Promise<void> {
  for (const d of drafts) {
    await db
      .update(computedMetrics)
      .set({ superseded: true })
      .where(
        and(
          eq(computedMetrics.userId, userId),
          eq(computedMetrics.metric, d.metric),
          eq(computedMetrics.scope, "activity"),
          eq(computedMetrics.scopeId, activityId),
          ne(computedMetrics.algorithmVersion, d.algorithmVersion),
        ),
      );
    await db
      .insert(computedMetrics)
      .values({
        userId,
        metric: d.metric,
        scope: "activity",
        scopeId: activityId,
        date,
        value: d.value,
        unit: d.unit,
        algorithmVersion: d.algorithmVersion,
        inputs: d.inputs,
      })
      .onConflictDoUpdate({
        target: [
          computedMetrics.userId,
          computedMetrics.metric,
          computedMetrics.scope,
          computedMetrics.scopeId,
          computedMetrics.date,
          computedMetrics.algorithmVersion,
        ],
        set: {
          value: d.value,
          unit: d.unit,
          inputs: d.inputs,
          computedAt: new Date(),
          superseded: false,
        },
      });
  }
}

// ---------------------------------------------------------------------------
// Activities upsert (merge on fingerprint)
// ---------------------------------------------------------------------------

type ActivityInsert = typeof activities.$inferInsert;

/** Measured columns that a later payload of the same activity may refresh (Garmin wins). */
const MERGE_KEYS = [
  "subSport",
  "startAt",
  "localDate",
  "utcOffsetMin",
  "durationSec",
  "distanceM",
  "avgHr",
  "maxHr",
  "avgPaceSecKm",
  "avgPowerW",
  "avgCadence",
  "elevationGainM",
  "calories",
  "avgStrideLengthM",
  "avgGctMs",
  "avgVerticalOscillationMm",
  "avgVerticalRatio",
  "gctBalance",
  "temperatureC",
  "deviceSerial",
  "parserVersion",
] as const satisfies ReadonlyArray<keyof ActivityInsert>;
type MergeKey = (typeof MERGE_KEYS)[number];

const excluded = (column: PgColumn): SQL => sql.raw(`excluded."${column.name}"`);

/**
 * ON CONFLICT set: Garmin overwrites the measured fields (and becomes the provider); a FIT file
 * only fills the gaps of what is already there. `raw_payload_id` is never touched (the original
 * reference is kept) and neither is `workout_id`.
 */
function mergeSet(provider: ActivityProvider) {
  const set: { [K in MergeKey]?: SQL } & { provider?: SQL; externalId?: SQL; updatedAt?: Date } = {
    updatedAt: new Date(),
  };
  for (const key of MERGE_KEYS) {
    const column = activities[key];
    set[key] =
      provider === "garmin" ? excluded(column) : sql`coalesce(${column}, ${excluded(column)})`;
  }
  if (provider === "garmin") {
    set.provider = sql`'garmin'`;
    set.externalId = excluded(activities.externalId);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Workout linking
// ---------------------------------------------------------------------------

interface NormalisedActivity {
  id: string;
  modality: Modality;
  sport: string;
  subSport: string | null;
  title: string;
  localDate: IsoDate;
  startAt: Date;
  finishedAt: Date;
  durationSec: number;
  distanceM: number | null;
  avgHr: number | null;
  provider: ActivityProvider;
  zoneSet: ResolvedZoneSet | null;
}

function measuredImpactUnits(a: Pick<NormalisedActivity, "modality" | "distanceM">): number | null {
  if (!isPositive(a.distanceM)) return null;
  if (a.modality === "running") return impactUnits({ runKm: a.distanceM / 1000 });
  if (a.modality === "walking") return impactUnits({ walkKm: a.distanceM / 1000 });
  return null;
}

/** Load profile of a free session of the measured duration, at the measured average-HR zone. */
function syntheticProfile(a: NormalisedActivity): LoadProfile {
  const zone = a.zoneSet && isPositive(a.avgHr) ? zoneForHr(a.zoneSet.set, a.avgHr) : 0;
  const target: CardioTarget = zone >= 1 ? { type: "hr_zone", zone } : { type: "open" };
  const spec: CardioWorkoutSpec = {
    modality: a.modality,
    kind: "free",
    title: a.title,
    steps: [{ kind: "work", durationSec: a.durationSec, target }],
  };
  const profile = expectedLoadProfile(spec);
  return { ...profile, impactUnits: measuredImpactUnits(a) ?? profile.impactUnits };
}

/**
 * Planned or in-progress cardio workout of the same athlete-local day whose modality matches
 * (`cardio_workouts.modality` when present, else the title); marked done from the measured
 * duration, the planned intensity kept (never guessed from HR), the ACTUAL analysis scaled from
 * the planned one (credits kept, source CALCULATED, confidence MEDIUM).
 */
async function linkPlannedWorkout(db: Db, userId: string, a: NormalisedActivity) {
  const candidates = await db
    .select({ w: workouts, modality: cardioWorkouts.modality })
    .from(workouts)
    .leftJoin(
      cardioWorkouts,
      and(eq(cardioWorkouts.workoutId, workouts.id), eq(cardioWorkouts.userId, userId)),
    )
    .where(
      and(
        eq(workouts.userId, userId),
        eq(workouts.date, a.localDate),
        eq(workouts.type, "cardio"),
        inArray(workouts.status, ["planned", "in_progress"]),
      ),
    )
    .orderBy(asc(workouts.startAt), asc(workouts.createdAt));
  const match = candidates.find(
    (c) => (c.modality ?? guessModalityFromTitle(c.w.title)) === a.modality,
  );
  if (!match) return null;
  const w = match.w;
  const actualMin = Math.max(1, Math.round(a.durationSec / 60));
  await db
    .update(workouts)
    .set({
      status: "done",
      actualDurationMin: actualMin,
      finishedAt: a.finishedAt,
      startAt: w.startAt ?? a.startAt,
      realisedIntensity: w.plannedIntensity,
    })
    .where(and(eq(workouts.id, w.id), eq(workouts.userId, userId)));

  const [planned] = await db
    .select()
    .from(workoutAnalyses)
    .where(and(eq(workoutAnalyses.workoutId, w.id), eq(workoutAnalyses.phase, "planned")))
    .limit(1);
  let row: ReturnType<typeof analysisRowFromProfile>;
  if (planned) {
    const scaled = scaleTemplateLoadToActual(planned.loadVector, {
      actualMin,
      plannedMin: w.plannedDurationMin,
    });
    const profile: LoadProfile = {
      expectedCredits: planned.stimulusCredits,
      loadVector: scaled.loadVector,
      intensity: planned.intensity,
      heavyStrength: planned.heavyStrength,
      durationMin: actualMin,
      modality: a.modality,
      patterns: planned.patternExposure,
      impactUnits: measuredImpactUnits(a) ?? planned.impactUnits,
    };
    row = analysisRowFromProfile(
      profile,
      "CALCULATED",
      `${planned.algorithmVersion}+${ACTUAL_SCALING_VERSION}`,
      0.6,
      planned.inputRef,
    );
  } else {
    row = analysisRowFromProfile(
      syntheticProfile(a),
      "CALCULATED",
      ACTIVITY_WORKOUT_ALGORITHM_VERSION,
      0.3,
      a.id,
    );
  }
  await db
    .insert(workoutAnalyses)
    .values({ userId, workoutId: w.id, phase: "actual", date: w.date, ...row })
    .onConflictDoUpdate({
      target: [workoutAnalyses.workoutId, workoutAnalyses.phase],
      set: { ...row, computedAt: new Date() },
    });
  return { id: w.id, title: w.title };
}

/** No planned session: a done cardio workout from the measured data, LOW-confidence analysis. */
async function createDoneWorkout(db: Db, userId: string, a: NormalisedActivity) {
  const profile = syntheticProfile(a);
  const actualMin = Math.max(1, Math.round(a.durationSec / 60));
  const [w] = await db
    .insert(workouts)
    .values({
      userId,
      type: "cardio",
      source: a.provider,
      status: "done",
      date: a.localDate,
      startAt: a.startAt,
      actualDurationMin: actualMin,
      title: a.title,
      realisedIntensity: profile.intensity,
      intensitySource: "CALCULATED",
      finishedAt: a.finishedAt,
      sessionRpeLoad: null,
    })
    .returning({ id: workouts.id, title: workouts.title });
  if (!w) throw new Error("workout insert failed");
  await db.insert(cardioWorkouts).values({
    userId,
    workoutId: w.id,
    modality: a.modality,
    workoutKind: "free",
    steps: [{ kind: "work", durationSec: a.durationSec, target: { type: "open" } }],
    zoneSetId: a.zoneSet?.id ?? null,
  });
  await db.insert(workoutAnalyses).values({
    userId,
    workoutId: w.id,
    phase: "actual",
    date: a.localDate,
    ...analysisRowFromProfile(profile, "CALCULATED", ACTIVITY_WORKOUT_ALGORITHM_VERSION, 0.3, a.id),
  });
  return w;
}

// ---------------------------------------------------------------------------
// PR detection (spec §58) — running distances, pro-rated best effort
// ---------------------------------------------------------------------------

const RUN_DISTANCES = [
  { key: "5k", meters: 5000, label: "5 km" },
  { key: "10k", meters: 10_000, label: "10 km" },
  { key: "half", meters: 21_097, label: "semi-marathon" },
] as const;
/** A run longer than this share of the distance is not a fair attempt at it (skip). */
const PR_MAX_DISTANCE_RATIO = 1.15;

async function detectRunPrs(
  db: Db,
  userId: string,
  a: NormalisedActivity,
  workoutId: string | null,
): Promise<string[]> {
  if (a.modality !== "running" || !isPositive(a.distanceM) || !isPositive(a.durationSec)) return [];
  const source: DataSource = a.provider === "garmin" ? "GARMIN" : "DEVICE";
  const out: string[] = [];
  for (const d of RUN_DISTANCES) {
    if (a.distanceM < d.meters || a.distanceM > d.meters * PR_MAX_DISTANCE_RATIO) continue;
    const timeSec = Math.round((a.durationSec * d.meters) / a.distanceM);
    const [current] = await db
      .select({ id: personalRecords.id, value: personalRecords.value })
      .from(personalRecords)
      .where(
        and(
          eq(personalRecords.userId, userId),
          eq(personalRecords.kind, "time"),
          eq(personalRecords.distanceKey, d.key),
          eq(personalRecords.superseded, false),
        ),
      )
      .orderBy(asc(personalRecords.value))
      .limit(1);
    if (current && current.value <= timeSec) continue;
    const [inserted] = await db
      .insert(personalRecords)
      .values({
        userId,
        kind: "time",
        distanceKey: d.key,
        value: timeSec,
        unit: "s",
        achievedAt: a.startAt,
        workoutId,
        activityId: a.id,
        source,
        estimated: a.distanceM > d.meters * 1.01,
        algorithmVersion: RUN_PR_ALGORITHM_VERSION,
        previousValue: current?.value ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: personalRecords.id });
    if (!inserted) continue;
    if (current)
      await db
        .update(personalRecords)
        .set({ superseded: true })
        .where(and(eq(personalRecords.id, current.id), eq(personalRecords.userId, userId)));
    out.push(`Nouveau record ${d.label} : ${clock(timeSec)}`);
  }
  return out;
}

/** A planned "Test 5 km" realised by a ≥ 5 km run → `test_results.test_run_5k` (spec §57). */
async function recordTest5k(
  db: Db,
  userId: string,
  a: NormalisedActivity,
  workout: { id: string; title: string } | null,
): Promise<void> {
  if (!workout || a.modality !== "running" || !isPositive(a.distanceM)) return;
  if (!/test\s*5/i.test(workout.title) || a.distanceM < 5000) return;
  const timeSec = Math.round((a.durationSec * 5000) / a.distanceM);
  const exact = a.distanceM <= 5000 * 1.03;
  await db
    .insert(testResults)
    .values({
      userId,
      testKey: "test_run_5k",
      date: a.localDate,
      value: timeSec,
      unit: "s",
      conditions: { distanceM: a.distanceM, avgHr: a.avgHr },
      activityId: a.id,
      workoutId: workout.id,
      source: a.provider === "garmin" ? "GARMIN" : "DEVICE",
      confidence: exact ? "HIGH" : "MEDIUM",
      algorithmVersion: exact ? null : RUN_PR_ALGORITHM_VERSION,
    })
    .onConflictDoNothing();
}

// ---------------------------------------------------------------------------
// Import pipeline
// ---------------------------------------------------------------------------

/**
 * Import one normalised activity (FIT or Garmin). Idempotent on `meta.dedupeKey`; merges on the
 * activity fingerprint `${sport}|${floor(startEpochSec / 60)}`.
 */
export async function importActivityDetails(
  db: Db,
  user: ImportUser,
  details: GarminActivityDetails,
  meta: ImportMeta,
): Promise<ImportResult> {
  const startMs = Date.parse(details.startTime);
  if (Number.isNaN(startMs))
    throw new AppError("Activité sans heure de départ", "INVALID_ACTIVITY");
  const durationSec = Math.max(0, Math.round(details.durationSec));
  const startAt = new Date(startMs);
  const finishedAt = new Date(startMs + durationSec * 1000);
  const utcOffsetMin =
    details.utcOffsetSec != null && Number.isFinite(details.utcOffsetSec)
      ? Math.round(details.utcOffsetSec / 60)
      : tzOffsetMinutes(startAt, user.timezone);
  const activityDate: IsoDate =
    details.utcOffsetSec != null && Number.isFinite(details.utcOffsetSec)
      ? new Date(startMs + details.utcOffsetSec * 1000).toISOString().slice(0, 10)
      : localDateOf(startAt, user.timezone);
  const fingerprint = `${details.sport}|${Math.floor(startMs / 60_000)}`;
  const modality = modalityForSport(details.sport, details.subSport);
  const avgSpeed = isPositive(details.avgSpeedMps) ? details.avgSpeedMps : null;
  const title = activityTitle(details.sport, details.subSport, details.distanceM, durationSec);

  return db.transaction(async (tx) => {
    // (a) raw payload — the dedupe key decides whether this payload is new.
    const [raw] = await tx
      .insert(rawPayloads)
      .values({
        userId: user.id,
        provider: meta.provider,
        kind: meta.rawKind,
        externalId: details.externalId,
        payload: details.raw,
        parserVersion: meta.parserVersion,
        dedupeKey: meta.dedupeKey,
      })
      .onConflictDoNothing()
      .returning({ id: rawPayloads.id });
    let rawId = raw?.id ?? null;
    if (!rawId) {
      const [existingRaw] = await tx
        .select({ id: rawPayloads.id })
        .from(rawPayloads)
        .where(and(eq(rawPayloads.userId, user.id), eq(rawPayloads.dedupeKey, meta.dedupeKey)))
        .limit(1);
      if (!existingRaw) throw new Error("raw_payloads dedupe lookup failed");
      rawId = existingRaw.id;
      const [existing] = await tx
        .select({ id: activities.id, workoutId: activities.workoutId })
        .from(activities)
        .where(
          and(
            eq(activities.userId, user.id),
            sql`(${activities.rawPayloadId} = ${rawId} or ${activities.fingerprint} = ${fingerprint})`,
          ),
        )
        .limit(1);
      if (existing)
        return {
          activityId: existing.id,
          workoutId: existing.workoutId,
          duplicate: true,
          merged: false,
          prs: [],
        };
      // Raw payload without an activity (an earlier import failed half-way): repair below.
    }

    // (b) activities upsert by fingerprint.
    const base: ActivityInsert = {
      userId: user.id,
      provider: meta.provider,
      externalId: details.externalId || null,
      fingerprint,
      sport: details.sport,
      subSport: details.subSport ?? null,
      startAt,
      localDate: activityDate,
      utcOffsetMin,
      durationSec,
      distanceM: details.distanceM ?? null,
      avgHr: details.avgHr != null ? Math.round(details.avgHr) : null,
      maxHr: details.maxHr != null ? Math.round(details.maxHr) : null,
      avgPaceSecKm: avgSpeed ? Math.round(1000 / avgSpeed) : null,
      avgPowerW: details.avgPowerW ?? null,
      avgCadence: details.avgCadence ?? null,
      elevationGainM: details.elevationGainM ?? null,
      calories: details.calories != null ? Math.round(details.calories) : null,
      avgStrideLengthM: details.runningDynamics?.avgStrideLengthM ?? null,
      avgGctMs: details.runningDynamics?.avgGctMs ?? null,
      avgVerticalOscillationMm: details.runningDynamics?.avgVerticalOscillationMm ?? null,
      avgVerticalRatio: details.runningDynamics?.avgVerticalRatio ?? null,
      gctBalance: details.runningDynamics?.gctBalance ?? null,
      temperatureC: details.temperatureC ?? null,
      deviceSerial: details.deviceSerial ?? null,
      rawPayloadId: rawId,
      parserVersion: meta.parserVersion,
    };
    const [row] = await tx
      .insert(activities)
      .values(base)
      .onConflictDoUpdate({
        target: [activities.userId, activities.fingerprint],
        set: mergeSet(meta.provider),
      })
      .returning();
    if (!row) throw new Error("activities upsert failed");
    const isNew = row.rawPayloadId === rawId;
    const merged = !isNew;
    // A FIT file merged onto an existing (Garmin) activity only fills gaps: derived data is kept.
    const refresh = isNew || meta.provider === "garmin";

    let zoneSet: ResolvedZoneSet | null = null;
    let prs: string[] = [];
    let workoutId = row.workoutId;

    if (refresh) {
      if (merged) {
        await tx.delete(activityLaps).where(eq(activityLaps.activityId, row.id));
        await tx.delete(activityStreams).where(eq(activityStreams.activityId, row.id));
      }
      // (c) laps + streams.
      if (details.laps.length)
        await tx.insert(activityLaps).values(
          details.laps.map((l, i) => {
            const lapStart = Date.parse(l.startTime);
            return {
              userId: user.id,
              activityId: row.id,
              lapIndex: i,
              startAt: Number.isNaN(lapStart) ? startAt : new Date(lapStart),
              durationSec: l.durationSec,
              distanceM: l.distanceM ?? null,
              avgHr: l.avgHr != null ? Math.round(l.avgHr) : null,
              maxHr: l.maxHr != null ? Math.round(l.maxHr) : null,
              avgPaceSecKm: isPositive(l.avgSpeedMps) ? Math.round(1000 / l.avgSpeedMps) : null,
              avgPowerW: l.avgPowerW ?? null,
              avgCadence: l.avgCadence ?? null,
              elevationGainM: l.elevationGainM ?? null,
            };
          }),
        );
      const intervalSec = isPositive(details.streams.sampleIntervalSec)
        ? details.streams.sampleIntervalSec
        : 1;
      const streams = buildStreams(details.streams);
      const streamEntries = Object.entries(streams) as Array<
        [ActivityStream, Array<number | null>]
      >;
      if (streamEntries.length)
        await tx.insert(activityStreams).values(
          streamEntries.map(([stream, values]) => ({
            userId: user.id,
            activityId: row.id,
            stream,
            sampleIntervalSec: intervalSec,
            values,
            count: values.length,
          })),
        );

      // (d) zones → time in zones; (e) comparable group.
      zoneSet = await resolveZoneSetForDate(tx, user.id, row.localDate);
      const tiz: TimeInZones | null =
        zoneSet && streams.hr ? timeInZones(zoneSet.set, streams.hr, intervalSec) : null;
      const avgZone = zoneSet && isPositive(row.avgHr) ? zoneForHr(zoneSet.set, row.avgHr) : 0;
      const comparableGroup = classifyComparableGroup({
        modality,
        durationMin: row.durationSec / 60,
        distanceM: row.distanceM,
        elevationGainM: row.elevationGainM,
        intensity: intensityFromZone(avgZone),
        indoor: indoorForSubSport(row.subSport),
        temperatureC: row.temperatureC,
      });
      await tx
        .update(activities)
        .set({ zoneSetId: zoneSet?.id ?? null, timeInZones: tiz, comparableGroup })
        .where(eq(activities.id, row.id));

      // (f) versioned metrics.
      await writeMetrics(
        tx,
        user.id,
        row.id,
        row.localDate,
        metricDrafts({
          modality,
          avgSpeedMps: avgSpeed,
          avgPowerW: row.avgPowerW,
          avgHr: row.avgHr,
          streams,
          intervalSec,
        }),
      );

      const normalised: NormalisedActivity = {
        id: row.id,
        modality,
        sport: row.sport,
        subSport: row.subSport,
        title,
        localDate: row.localDate,
        startAt: row.startAt,
        finishedAt,
        durationSec: row.durationSec,
        distanceM: row.distanceM,
        avgHr: row.avgHr,
        provider: meta.provider,
        zoneSet,
      };

      // (g) workout link — only once per activity.
      let linked: { id: string; title: string } | null = null;
      if (!workoutId) {
        linked = await linkPlannedWorkout(tx, user.id, normalised);
        if (!linked && ENDURANCE_MODALITIES.includes(modality))
          linked = await createDoneWorkout(tx, user.id, normalised);
        if (linked) {
          workoutId = linked.id;
          await tx
            .update(activities)
            .set({ workoutId: linked.id })
            .where(eq(activities.id, row.id));
        }
      }

      // (h) PRs and tests.
      prs = await detectRunPrs(tx, user.id, normalised, workoutId);
      await recordTest5k(tx, user.id, normalised, linked);
    }

    log.info("activity.imported", {
      userId: user.id,
      activityId: row.id,
      workoutId: workoutId ?? undefined,
      provider: meta.provider,
      kind: merged ? "merged" : "new",
      count: prs.length,
    });
    return { activityId: row.id, workoutId, duplicate: false, merged, prs };
  });
}

/** Parse a FIT file and import it (`fit:<sha256>` dedupe). Parser warnings are passed through. */
export async function importFitFile(
  db: Db,
  user: ImportUser,
  bytes: Uint8Array,
  filename: string,
): Promise<FitImportResult> {
  let parsed: ParsedFit;
  try {
    parsed = parseFit(bytes);
  } catch (err) {
    throw new InvalidFitError(err instanceof Error ? err.message : "Fichier FIT illisible");
  }
  const rawObject =
    parsed.activity.raw && typeof parsed.activity.raw === "object"
      ? (parsed.activity.raw as Record<string, unknown>)
      : {};
  const activity: GarminActivityDetails = {
    ...parsed.activity,
    raw: { filename, timeCreated: parsed.timeCreated, ...rawObject },
  };
  const result = await importActivityDetails(db, user, activity, {
    provider: "fit_import",
    dedupeKey: `fit:${parsed.sha256}`,
    parserVersion: FIT_PARSER_VERSION,
    rawKind: "fit_activity",
  });
  return { ...result, warnings: parsed.warnings };
}

/** Pull the provider's activities over a range through the same pipeline (`garmin:activity:<id>`). */
export async function syncGarminActivities(
  db: Db,
  user: ImportUser,
  range: { from: IsoDateTime; to: IsoDateTime },
  ctx: GarminSyncContext = defaultGarminContext(),
): Promise<GarminSyncResult> {
  if (!ctx.enabled) throw new FeatureDisabledError("garmin");
  const summaries = await ctx.provider.getActivities(user.id, range);
  let imported = 0;
  let duplicates = 0;
  const prs: string[] = [];
  for (const summary of summaries) {
    const details = await ctx.provider.getActivity(user.id, summary.externalId);
    if (!details) continue;
    const result = await importActivityDetails(db, user, details, {
      provider: "garmin",
      dedupeKey: `garmin:activity:${details.externalId}`,
      parserVersion: GARMIN_IMPORT_VERSION,
      rawKind: "activity",
    });
    if (result.duplicate) duplicates += 1;
    else imported += 1;
    prs.push(...result.prs);
  }
  log.info("activity.garmin_synced", {
    userId: user.id,
    provider: ctx.provider.name,
    count: imported,
  });
  return { imported, duplicates, prs };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface ActivityListItem {
  id: string;
  provider: string;
  sport: string;
  subSport: string | null;
  modality: Modality;
  title: string;
  localDate: IsoDate;
  startAt: string;
  durationSec: number;
  distanceM: number | null;
  avgHr: number | null;
  avgPaceSecKm: number | null;
  comparableGroup: string | null;
  workoutId: string | null;
}

export interface StreamPoint {
  /** Seconds since the start. */
  t: number;
  v: number | null;
}

export interface ActivityLapView {
  lapIndex: number;
  durationSec: number;
  distanceM: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgPaceSecKm: number | null;
  avgPowerW: number | null;
  avgCadence: number | null;
  elevationGainM: number | null;
}

export interface ActivityMetricView {
  key: string;
  label: string;
  value: number;
  unit: string;
  algorithmVersion: string;
  /** Computed metrics are estimates by construction (rendered with "≈"). */
  estimated: true;
  detail: string | null;
}

export interface ActivityZonesView {
  setId: string;
  method: HrZoneMethod;
  lthr: number | null;
  source: DataSource;
  confidence: Confidence;
  zones: HrZone[];
  timeInZones: TimeInZones;
}

export interface ActivityRunningDynamicsView {
  avgStrideLengthM: number | null;
  avgGctMs: number | null;
  avgVerticalOscillationMm: number | null;
  avgVerticalRatio: number | null;
  gctBalance: number | null;
}

export interface ActivityDetailView {
  activity: ActivityListItem & {
    maxHr: number | null;
    avgPowerW: number | null;
    avgCadence: number | null;
    elevationGainM: number | null;
    calories: number | null;
    temperatureC: number | null;
    deviceSerial: string | null;
    parserVersion: string;
    utcOffsetMin: number | null;
    runningDynamics: ActivityRunningDynamicsView | null;
  };
  laps: ActivityLapView[];
  streams: Partial<Record<ActivityStream, StreamPoint[]>>;
  zones: ActivityZonesView | null;
  metrics: ActivityMetricView[];
  workout: { id: string; title: string; status: WorkoutStatus; rpe: number | null } | null;
}

const METRIC_LABEL_FR: Record<string, string> = {
  efficiency_factor: "Efficience aérobie (EF)",
  aerobic_decoupling: "Découplage aérobie",
  rd_cadence: "Cadence (dynamique)",
  rd_stride_length: "Longueur de foulée",
  rd_gct: "Temps de contact au sol",
  rd_vertical_oscillation: "Oscillation verticale",
  rd_vertical_ratio: "Ratio vertical",
  rd_gct_balance: "Équilibre contact au sol",
};

function metricDetail(metric: string, inputs: MetricInputs): string | null {
  if (metric === "aerobic_decoupling") {
    const a = inputs.firstHalfEf;
    const b = inputs.secondHalfEf;
    const basis = inputs.basis === "power" ? "puissance" : "vitesse";
    if (typeof a === "number" && typeof b === "number")
      return `EF ${a.toFixed(2)} → ${b.toFixed(2)} (${basis}, après échauffement)`;
    return null;
  }
  if (metric === "efficiency_factor")
    return inputs.basis === "power" ? "puissance / FC moyenne" : "vitesse / FC moyenne";
  if (metric.startsWith("rd_") && typeof inputs.sampleCount === "number")
    return `${inputs.sampleCount} échantillons`;
  return null;
}

/** Downsample a stream to at most `max` points (bucket means; an all-null bucket stays null). */
export function toStreamPoints(
  values: ReadonlyArray<number | null>,
  intervalSec: number,
  max = MAX_CHART_POINTS,
): StreamPoint[] {
  const n = values.length;
  if (n === 0) return [];
  const bucket = Math.max(1, Math.ceil(n / max));
  const out: StreamPoint[] = [];
  for (let i = 0; i < n; i += bucket) {
    let sum = 0;
    let count = 0;
    for (let j = i; j < Math.min(n, i + bucket); j++) {
      const v = values[j];
      if (v != null && Number.isFinite(v)) {
        sum += v;
        count += 1;
      }
    }
    out.push({ t: i * intervalSec, v: count ? Math.round((sum / count) * 100) / 100 : null });
  }
  return out;
}

type ActivityRow = typeof activities.$inferSelect;

function toListItem(row: ActivityRow): ActivityListItem {
  return {
    id: row.id,
    provider: row.provider,
    sport: row.sport,
    subSport: row.subSport,
    modality: modalityForSport(row.sport, row.subSport),
    title: activityTitle(row.sport, row.subSport, row.distanceM, row.durationSec),
    localDate: row.localDate,
    startAt: row.startAt.toISOString(),
    durationSec: row.durationSec,
    distanceM: row.distanceM,
    avgHr: row.avgHr,
    avgPaceSecKm: row.avgPaceSecKm,
    comparableGroup: row.comparableGroup,
    workoutId: row.workoutId,
  };
}

export async function listActivities(
  db: Db,
  userId: string,
  limit = 50,
): Promise<ActivityListItem[]> {
  const rows = await db
    .select()
    .from(activities)
    .where(eq(activities.userId, userId))
    .orderBy(desc(activities.startAt))
    .limit(Math.max(1, Math.min(200, limit)));
  return rows.map(toListItem);
}

export async function getActivityDetail(
  db: Db,
  userId: string,
  id: string,
): Promise<ActivityDetailView | null> {
  const [row] = await db
    .select()
    .from(activities)
    .where(and(eq(activities.id, id), eq(activities.userId, userId)))
    .limit(1);
  if (!row) return null;

  const [laps, streamRows, metricRows, zoneRow, workoutRow] = await Promise.all([
    db
      .select()
      .from(activityLaps)
      .where(and(eq(activityLaps.activityId, row.id), eq(activityLaps.userId, userId)))
      .orderBy(asc(activityLaps.lapIndex)),
    db
      .select()
      .from(activityStreams)
      .where(and(eq(activityStreams.activityId, row.id), eq(activityStreams.userId, userId))),
    db
      .select()
      .from(computedMetrics)
      .where(
        and(
          eq(computedMetrics.userId, userId),
          eq(computedMetrics.scope, "activity"),
          eq(computedMetrics.scopeId, row.id),
          eq(computedMetrics.superseded, false),
        ),
      )
      .orderBy(asc(computedMetrics.metric)),
    row.zoneSetId
      ? db
          .select()
          .from(hrZoneSets)
          .where(and(eq(hrZoneSets.id, row.zoneSetId), eq(hrZoneSets.userId, userId)))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
    row.workoutId
      ? db
          .select({
            id: workouts.id,
            title: workouts.title,
            status: workouts.status,
            rpe: workouts.rpe,
          })
          .from(workouts)
          .where(and(eq(workouts.id, row.workoutId), eq(workouts.userId, userId)))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
  ]);

  const streams: Partial<Record<ActivityStream, StreamPoint[]>> = {};
  for (const s of streamRows) streams[s.stream] = toStreamPoints(s.values, s.sampleIntervalSec);

  const hasDynamics =
    row.avgStrideLengthM != null ||
    row.avgGctMs != null ||
    row.avgVerticalOscillationMm != null ||
    row.avgVerticalRatio != null ||
    row.gctBalance != null;
  const rd = hasDynamics
    ? {
        avgStrideLengthM: row.avgStrideLengthM,
        avgGctMs: row.avgGctMs,
        avgVerticalOscillationMm: row.avgVerticalOscillationMm,
        avgVerticalRatio: row.avgVerticalRatio,
        gctBalance: row.gctBalance,
      }
    : null;

  return {
    activity: {
      ...toListItem(row),
      maxHr: row.maxHr,
      avgPowerW: row.avgPowerW,
      avgCadence: row.avgCadence,
      elevationGainM: row.elevationGainM,
      calories: row.calories,
      temperatureC: row.temperatureC,
      deviceSerial: row.deviceSerial,
      parserVersion: row.parserVersion,
      utcOffsetMin: row.utcOffsetMin,
      runningDynamics: rd,
    },
    laps: laps.map((l) => ({
      lapIndex: l.lapIndex,
      durationSec: l.durationSec,
      distanceM: l.distanceM,
      avgHr: l.avgHr,
      maxHr: l.maxHr,
      avgPaceSecKm: l.avgPaceSecKm,
      avgPowerW: l.avgPowerW,
      avgCadence: l.avgCadence,
      elevationGainM: l.elevationGainM,
    })),
    streams,
    zones:
      zoneRow && row.timeInZones
        ? {
            setId: zoneRow.id,
            method: zoneRow.method,
            lthr: zoneRow.lthr,
            source: zoneRow.source,
            confidence: zoneRow.confidence,
            zones: zoneRow.zones,
            timeInZones: row.timeInZones,
          }
        : null,
    metrics: metricRows.map((m) => ({
      key: m.metric,
      label: METRIC_LABEL_FR[m.metric] ?? m.metric,
      value: m.value,
      unit: m.unit,
      algorithmVersion: m.algorithmVersion,
      estimated: true,
      detail: metricDetail(m.metric, m.inputs),
    })),
    workout: workoutRow
      ? {
          id: workoutRow.id,
          title: workoutRow.title,
          status: workoutRow.status,
          rpe: workoutRow.rpe,
        }
      : null,
  };
}
