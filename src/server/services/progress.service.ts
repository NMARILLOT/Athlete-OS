import "server-only";
import { and, asc, desc, eq, gte, inArray, lte, min, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  activities,
  benchmarkResults,
  benchmarks,
  computedMetrics,
  personalRecords,
  recoveryMetrics,
  strengthSets,
  testResults,
  workoutAnalyses,
  workouts,
  type BenchmarkScoreKind,
} from "@/db/schema";
import { thresholdEstimateFromTest } from "@/domain/cardio";
import { FEELING_TO_FUN, type IntensityBand } from "@/domain/core";
import { addDays, daysBetween, isoWeekEnd, isoWeekStart, type IsoDate } from "@/domain/core/dates";
import { BENCHMARK_LIFT_IDS, getExercise } from "@/domain/exercises";
import { dailyLoadSeries, intensityFromRpe, sessionRpeLoad, trailingSum } from "@/domain/load";
import { weeklyMuscleHeatmap, weeklyPatternHeatmap, type ExposedSession } from "@/domain/stimulus";
import { formatDurationSec } from "@/lib/format";
import { localDate } from "@/server/time";
import type { ProgressView } from "./view-models";

/**
 * Progress dashboards (spec §27, §19 "pas de score magique", §20 load, §70 estimated ≠ measured).
 *
 * Everything here is a transparent aggregate of stored rows: minutes are summed, e1RM points come
 * from the sets that produced them, load is session-RPE (duration × RPE). Nothing is blended into
 * a composite score. When a datum is missing the view carries `null` / an empty array and the UI
 * shows "—" or an empty state — never a made-up value.
 */

/** One pace @ HR point; `basis` says what the pace actually is (spec §17, §70). */
export interface PaceAtHrPoint {
  date: string;
  paceSecKm: number;
  /** "140–149": the 10-bpm bucket of the average HR, or the exact band of the steady-state estimate. */
  hrBand: string;
  /**
   * `pace_at_hr`: the versioned computed metric (pace of the steady samples inside the Z2 band);
   * `activity_average`: whole-activity average pace at the whole-activity average HR.
   */
  basis: "pace_at_hr" | "activity_average";
}

/** One series per comparable group (spec §30): groups are never merged into one trend. */
export interface PaceAtHrSeries {
  comparableGroup: string;
  points: PaceAtHrPoint[];
  /**
   * At least one point comes from the development mock (`activities.provider = garmin_mock`): the
   * series is simulated and must be labelled so, never "mesuré" (spec §14, §70, ADR-023).
   */
  simulated: boolean;
}

/** `ProgressView` with the pace @ HR trend split per comparable group. */
export type ProgressPageView = Omit<ProgressView, "engine"> & {
  engine: Omit<ProgressView["engine"], "paceAtHr"> & { paceAtHr: PaceAtHrSeries[] };
};

export const PROGRESS_RANGE_VALUES = ["7d", "4w", "3m", "6m", "1y", "all"] as const;
export type ProgressRange = (typeof PROGRESS_RANGE_VALUES)[number];

export function isProgressRange(value: string | undefined): value is ProgressRange {
  return (PROGRESS_RANGE_VALUES as readonly string[]).includes(value ?? "");
}

/** Days covered by each range (inclusive of today); `all` is resolved from the data. */
const RANGE_DAYS: Record<Exclude<ProgressRange, "all">, number> = {
  "7d": 7,
  "4w": 28,
  "3m": 91,
  "6m": 182,
  "1y": 365,
};

/** Trailing window used by the load indicator (acute 7 d vs chronic 4 weeks), spec §20. */
const LOAD_WINDOW_DAYS = 28;
/** Minimum history before a load ratio is shown at all (never invented on thin data). */
const LOAD_RATIO_MIN_HISTORY_DAYS = 21;

/** Recovery metrics pivoted into the Récupération section; keys are `recovery_metrics.metric`. */
const RECOVERY_METRIC_KEYS = ["resting_hr", "hrv_rmssd", "sleep_hours", "body_battery"] as const;
/** Measured sources win over anything typed by hand when the same day has several rows. */
const RECOVERY_SOURCE_PRIORITY: readonly string[] = ["GARMIN", "DEVICE", "SCALE", "USER", "MANUAL"];

/** Free workouts whose title says "walk" count as recovery, not endurance. */
const WALK_TITLE_RE = /\b(marche|walk|walking|balade|rando|randonn)/i;

type DistributionBucket = "crossfit" | "strength" | "easyEndurance" | "hardEndurance" | "recovery";

interface DoneWorkoutRow {
  date: string;
  type: (typeof workouts.$inferSelect)["type"];
  title: string;
  plannedDurationMin: number | null;
  actualDurationMin: number | null;
  plannedIntensity: IntensityBand | null;
  realisedIntensity: IntensityBand | null;
  rpe: number | null;
  feeling: (typeof workouts.$inferSelect)["feeling"];
  sessionRpeLoad: number | null;
}

/** Minutes a done workout counts for: what was measured, else what was planned, else nothing. */
function minutesOf(w: DoneWorkoutRow): number {
  const m = w.actualDurationMin ?? w.plannedDurationMin;
  return m != null && Number.isFinite(m) && m > 0 ? m : 0;
}

/** Realised band first, then the planned one, then the RPE-derived band; `easy` when unknown. */
function intensityOf(w: DoneWorkoutRow): IntensityBand {
  return w.realisedIntensity ?? w.plannedIntensity ?? intensityFromRpe(w.rpe) ?? "easy";
}

/**
 * Distribution mapping (spec §27) — one bucket per done workout:
 *  - `crossfit`       ← type `crossfit`
 *  - `strength`       ← type `strength`
 *  - `recovery`       ← types `mobility`, `rest`, `coach_session`, and `free` workouts that are
 *                        easy and titled like a walk (marche / walk / balade / rando)
 *  - `easyEndurance`  ← types `cardio` / `free` with intensity `easy`
 *  - `hardEndurance`  ← types `cardio` / `free` with intensity `moderate` or `hard`
 * Intensity = realised band, else planned band, else the RPE band, else `easy`.
 */
export function distributionBucketOf(w: DoneWorkoutRow): DistributionBucket {
  switch (w.type) {
    case "crossfit":
      return "crossfit";
    case "strength":
      return "strength";
    case "mobility":
    case "rest":
    case "coach_session":
      return "recovery";
    case "free":
    case "cardio": {
      const intensity = intensityOf(w);
      if (w.type === "free" && intensity === "easy" && WALK_TITLE_RE.test(w.title))
        return "recovery";
      return intensity === "easy" ? "easyEndurance" : "hardEndurance";
    }
  }
}

/** Session-RPE load of a done workout: stored value, else duration × RPE, else null (unknown). */
function loadOf(w: DoneWorkoutRow): number | null {
  if (w.sessionRpeLoad != null && Number.isFinite(w.sessionRpeLoad)) return w.sessionRpeLoad;
  const minutes = minutesOf(w);
  return minutes > 0 ? sessionRpeLoad(minutes, w.rpe) : null;
}

/** Every ISO week Monday between two dates (inclusive), so charts have a bar per week. */
function weekStartsBetween(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  let w = isoWeekStart(from);
  while (w <= to) {
    out.push(w);
    w = addDays(w, 7);
  }
  return out;
}

/** "140–149" for an average HR of 143 (10 bpm buckets, spec §17 pace @ HR). */
export function hrBandOf(avgHr: number): string {
  const lo = Math.floor(avgHr / 10) * 10;
  return `${lo}–${lo + 9}`;
}

/**
 * Benchmark score as text. `benchmark_results` stores one number per score kind: seconds for a
 * time, kg for a load, reps for reps; for `rounds_reps` the integer part is the rounds and the
 * fractional part (×100) the extra reps ("12.07" → 12 rounds + 7 reps).
 */
export function formatBenchmarkScore(kind: BenchmarkScoreKind, value: number): string {
  switch (kind) {
    case "time":
      return formatDurationSec(value);
    case "load":
      return `${Number.isInteger(value) ? value : value.toFixed(1)} kg`;
    case "reps":
      return `${Math.round(value)} reps`;
    case "rounds_reps": {
      const rounds = Math.floor(value);
      const extra = Math.round((value - rounds) * 100);
      return extra > 0 ? `${rounds} rounds + ${extra} reps` : `${rounds} rounds`;
    }
  }
}

/** Seconds from a test result whose unit is seconds or minutes; null for any other unit. */
function testTimeSec(value: number, unit: string): number | null {
  const u = unit.trim().toLowerCase();
  if (u === "s" || u === "sec" || u === "seconds" || u === "secondes") return value;
  if (u === "min" || u === "minutes") return value * 60;
  return null;
}

/** Earliest day with any stored data (for the `all` range); today when nothing is stored. */
async function earliestDataDate(db: Db, userId: string, today: IsoDate): Promise<IsoDate> {
  const [w] = await db
    .select({ d: min(workouts.date) })
    .from(workouts)
    .where(eq(workouts.userId, userId));
  const [a] = await db
    .select({ d: min(activities.localDate) })
    .from(activities)
    .where(eq(activities.userId, userId));
  const [r] = await db
    .select({ d: min(recoveryMetrics.date) })
    .from(recoveryMetrics)
    .where(eq(recoveryMetrics.userId, userId));
  const candidates = [w?.d, a?.d, r?.d].filter((d): d is string => typeof d === "string");
  const earliest = candidates.sort()[0];
  return earliest && earliest < today ? earliest : today;
}

export function rangeBounds(range: ProgressRange, today: IsoDate, earliest: IsoDate) {
  const from = range === "all" ? earliest : addDays(today, -(RANGE_DAYS[range] - 1));
  return { from, to: today };
}

/**
 * One pass over a handful of range-bounded, user-scoped queries → `ProgressView`.
 * `today` is the athlete-local day; `timezone` only serves to turn PR timestamps into local days.
 */
export async function getProgressView(
  db: Db,
  userId: string,
  range: ProgressRange,
  today: IsoDate,
  opts: { timezone?: string } = {},
): Promise<ProgressPageView> {
  const timezone = opts.timezone ?? "UTC";
  const earliest = range === "all" ? await earliestDataDate(db, userId, today) : today;
  const { from, to } = rangeBounds(range, today, earliest);
  // The load indicator always looks back 28 days, whatever the displayed range.
  const loadFrom = addDays(to, -(LOAD_WINDOW_DAYS - 1));
  const queryFrom = loadFrom < from ? loadFrom : from;

  const doneRows: DoneWorkoutRow[] = await db
    .select({
      date: workouts.date,
      type: workouts.type,
      title: workouts.title,
      plannedDurationMin: workouts.plannedDurationMin,
      actualDurationMin: workouts.actualDurationMin,
      plannedIntensity: workouts.plannedIntensity,
      realisedIntensity: workouts.realisedIntensity,
      rpe: workouts.rpe,
      feeling: workouts.feeling,
      sessionRpeLoad: workouts.sessionRpeLoad,
    })
    .from(workouts)
    .where(
      and(
        eq(workouts.userId, userId),
        eq(workouts.status, "done"),
        gte(workouts.date, queryFrom),
        lte(workouts.date, to),
      ),
    )
    .orderBy(asc(workouts.date));
  const inRange = doneRows.filter((w) => w.date >= from);

  // Volume + distribution: minutes per ISO week (dense weeks so every chart has the same x axis).
  const weeks = weekStartsBetween(from, to);
  const volumeByWeek = new Map<string, number>(weeks.map((w) => [w, 0]));
  const distByWeek = new Map<string, Record<DistributionBucket, number>>(
    weeks.map((w) => [
      w,
      { crossfit: 0, strength: 0, easyEndurance: 0, hardEndurance: 0, recovery: 0 },
    ]),
  );
  for (const w of inRange) {
    const week = isoWeekStart(w.date);
    const minutes = minutesOf(w);
    volumeByWeek.set(week, (volumeByWeek.get(week) ?? 0) + minutes);
    const buckets = distByWeek.get(week);
    if (buckets) buckets[distributionBucketOf(w)] += minutes;
  }

  // Enjoyment: declared feeling → documented fun score, averaged when a day has several sessions.
  const funByDate = new Map<string, number[]>();
  for (const w of inRange) {
    if (!w.feeling) continue;
    funByDate.set(w.date, [...(funByDate.get(w.date) ?? []), FEELING_TO_FUN[w.feeling]]);
  }
  const enjoyment = [...funByDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, scores]) => ({
      date,
      fun: Math.round((scores.reduce((s, v) => s + v, 0) / scores.length) * 10) / 10,
    }));

  // Load: daily session-RPE over the displayed range; acute/chronic on the trailing 28 days.
  const loadSessions = doneRows.map((w) => ({ date: w.date, load: loadOf(w) }));
  const daily = dailyLoadSeries(loadSessions, from, to);
  const trailing = dailyLoadSeries(loadSessions, loadFrom, to);
  const acute7d = Math.round(trailingSum(trailing, 7));
  const chronicWeeklyAvg = Math.round(trailingSum(trailing, LOAD_WINDOW_DAYS) / 4);
  const firstLoadDate = loadSessions.find((s) => s.load != null && s.date >= loadFrom)?.date;
  const historyDays = firstLoadDate ? daysBetween(firstLoadDate, to) + 1 : 0;
  const ratio =
    chronicWeeklyAvg > 0 && historyDays >= LOAD_RATIO_MIN_HISTORY_DAYS
      ? Math.round((acute7d / chronicWeeklyAvg) * 100) / 100
      : null;

  // Strength: weekly best e1RM per benchmark lift, from the working sets that produced them.
  const benchmarkIds = [...BENCHMARK_LIFT_IDS];
  const setRows = benchmarkIds.length
    ? await db
        .select({
          exerciseId: strengthSets.exerciseId,
          date: strengthSets.date,
          e1rmKg: strengthSets.e1rmKg,
        })
        .from(strengthSets)
        .where(
          and(
            eq(strengthSets.userId, userId),
            eq(strengthSets.isWarmup, false),
            sql`${strengthSets.e1rmKg} is not null`,
            inArray(strengthSets.exerciseId, benchmarkIds),
            gte(strengthSets.date, from),
            lte(strengthSets.date, to),
          ),
        )
    : [];
  const bestByLiftWeek = new Map<string, Map<string, number>>();
  for (const s of setRows) {
    if (s.e1rmKg == null) continue;
    const week = isoWeekStart(s.date);
    const byWeek = bestByLiftWeek.get(s.exerciseId) ?? new Map<string, number>();
    byWeek.set(week, Math.max(byWeek.get(week) ?? 0, s.e1rmKg));
    bestByLiftWeek.set(s.exerciseId, byWeek);
  }
  const strength = benchmarkIds
    .filter((id) => bestByLiftWeek.has(id))
    .map((exerciseId) => ({
      exerciseId,
      name: getExercise(exerciseId)?.name ?? exerciseId,
      points: [...(bestByLiftWeek.get(exerciseId) ?? new Map<string, number>()).entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([date, e1rmKg]) => ({ date, e1rmKg })),
    }));

  // Engine: pace @ HR on easy runs, one series per comparable group (spec §30 — a 45-min flat run
  // and a 2-h hilly long run are never plotted as one trend). The versioned `pace_at_hr` metric
  // (steady samples inside Z2) is preferred; otherwise the whole-activity average pace at the
  // average HR, and the point says which (`basis`). Activities without a group are not "comparable".
  // Simulated activities (`garmin_mock`) stay on the chart (spec §14) but flag their series.
  const activityRows = await db
    .select({
      id: activities.id,
      localDate: activities.localDate,
      avgHr: activities.avgHr,
      avgPaceSecKm: activities.avgPaceSecKm,
      comparableGroup: activities.comparableGroup,
      provider: activities.provider,
    })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        gte(activities.localDate, from),
        lte(activities.localDate, to),
        sql`${activities.avgHr} is not null`,
        sql`${activities.avgPaceSecKm} is not null`,
        sql`${activities.comparableGroup} like 'easy_run%'`,
      ),
    )
    .orderBy(asc(activities.localDate), asc(activities.startAt));
  const paceMetricRows = activityRows.length
    ? await db
        .select({
          scopeId: computedMetrics.scopeId,
          value: computedMetrics.value,
          inputs: computedMetrics.inputs,
        })
        .from(computedMetrics)
        .where(
          and(
            eq(computedMetrics.userId, userId),
            eq(computedMetrics.metric, "pace_at_hr"),
            eq(computedMetrics.scope, "activity"),
            eq(computedMetrics.superseded, false),
            inArray(
              computedMetrics.scopeId,
              activityRows.map((a) => a.id),
            ),
          ),
        )
    : [];
  const paceMetricByActivity = new Map(
    paceMetricRows.flatMap((r) => (r.scopeId ? [[r.scopeId, r] as const] : [])),
  );
  const pointsByGroup = new Map<string, { points: PaceAtHrPoint[]; simulated: boolean }>();
  for (const a of activityRows) {
    if (!a.comparableGroup || a.avgHr == null) continue;
    const metric = paceMetricByActivity.get(a.id);
    let point: PaceAtHrPoint | null = null;
    if (metric && Number.isFinite(metric.value) && metric.value > 0) {
      const lo = metric.inputs.hrMin;
      const hi = metric.inputs.hrMax;
      point = {
        date: a.localDate,
        paceSecKm: Math.round(metric.value),
        hrBand:
          typeof lo === "number" && typeof hi === "number" ? `${lo}–${hi}` : hrBandOf(a.avgHr),
        basis: "pace_at_hr",
      };
    } else if (a.avgPaceSecKm != null && a.avgPaceSecKm > 0) {
      point = {
        date: a.localDate,
        paceSecKm: Math.round(a.avgPaceSecKm),
        hrBand: hrBandOf(a.avgHr),
        basis: "activity_average",
      };
    }
    if (!point) continue;
    const group = pointsByGroup.get(a.comparableGroup) ?? { points: [], simulated: false };
    group.points.push(point);
    if (a.provider === "garmin_mock") group.simulated = true;
    pointsByGroup.set(a.comparableGroup, group);
  }
  // Most populated group first (the athlete's usual outing), then alphabetical for stability.
  const paceAtHr: PaceAtHrSeries[] = [...pointsByGroup.entries()]
    .sort(([ga, pa], [gb, pb]) => pb.points.length - pa.points.length || (ga < gb ? -1 : 1))
    .map(([comparableGroup, { points, simulated }]) => ({ comparableGroup, points, simulated }));

  const thresholdRows = await db
    .select({ date: computedMetrics.date, value: computedMetrics.value })
    .from(computedMetrics)
    .where(
      and(
        eq(computedMetrics.userId, userId),
        eq(computedMetrics.metric, "threshold_pace_sec_km"),
        eq(computedMetrics.superseded, false),
        gte(computedMetrics.date, from),
        lte(computedMetrics.date, to),
      ),
    );
  const testRows = await db
    .select({
      date: testResults.date,
      testKey: testResults.testKey,
      value: testResults.value,
      unit: testResults.unit,
    })
    .from(testResults)
    .where(
      and(eq(testResults.userId, userId), gte(testResults.date, from), lte(testResults.date, to)),
    )
    .orderBy(desc(testResults.date));
  const thresholdPace: ProgressView["engine"]["thresholdPace"] = thresholdRows
    .filter((r) => Number.isFinite(r.value) && r.value > 0)
    .map((r) => ({ date: r.date, paceSecKm: Math.round(r.value) }));
  for (const t of testRows) {
    if (t.testKey !== "run_5k" && t.testKey !== "test_run_5k") continue;
    const sec = testTimeSec(t.value, t.unit);
    const estimate = thresholdEstimateFromTest("run_5k", sec);
    if (estimate?.thresholdPaceSecKm != null)
      thresholdPace.push({ date: t.date, paceSecKm: estimate.thresholdPaceSecKm });
  }
  thresholdPace.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // CrossFit: benchmark results with their benchmark, PRs with their exercise name.
  const benchmarkRows = await db
    .select({
      benchmarkId: benchmarkResults.benchmarkId,
      name: benchmarks.name,
      date: benchmarkResults.date,
      scoreValue: benchmarkResults.scoreValue,
      scoreKind: benchmarkResults.scoreKind,
      rx: benchmarkResults.rx,
    })
    .from(benchmarkResults)
    .innerJoin(benchmarks, eq(benchmarks.id, benchmarkResults.benchmarkId))
    .where(
      and(
        eq(benchmarkResults.userId, userId),
        gte(benchmarkResults.date, from),
        lte(benchmarkResults.date, to),
      ),
    )
    .orderBy(desc(benchmarkResults.date));
  const prRows = await db
    .select({
      exerciseId: personalRecords.exerciseId,
      kind: personalRecords.kind,
      value: personalRecords.value,
      unit: personalRecords.unit,
      achievedAt: personalRecords.achievedAt,
      estimated: personalRecords.estimated,
    })
    .from(personalRecords)
    .where(
      and(
        eq(personalRecords.userId, userId),
        eq(personalRecords.superseded, false),
        sql`${personalRecords.exerciseId} is not null`,
        // One day of slack on each side: the range is athlete-local, the column an instant.
        gte(personalRecords.achievedAt, new Date(`${addDays(from, -1)}T00:00:00Z`)),
        lte(personalRecords.achievedAt, new Date(`${addDays(to, 1)}T23:59:59Z`)),
      ),
    )
    .orderBy(desc(personalRecords.achievedAt));
  const prs: ProgressView["crossfit"]["prs"] = [];
  for (const r of prRows) {
    if (!r.exerciseId) continue;
    const date = localDate(r.achievedAt, timezone);
    if (date < from || date > to) continue;
    prs.push({
      exerciseId: r.exerciseId,
      name: getExercise(r.exerciseId)?.name ?? r.exerciseId,
      value: r.value,
      unit: r.unit,
      date,
      estimated: r.estimated,
    });
  }

  // Recovery: measured metrics pivoted per day; null when a day lacks a metric.
  const recoveryRows = await db
    .select({
      date: recoveryMetrics.date,
      metric: recoveryMetrics.metric,
      value: recoveryMetrics.value,
      source: recoveryMetrics.source,
    })
    .from(recoveryMetrics)
    .where(
      and(
        eq(recoveryMetrics.userId, userId),
        inArray(recoveryMetrics.metric, [...RECOVERY_METRIC_KEYS]),
        gte(recoveryMetrics.date, from),
        lte(recoveryMetrics.date, to),
      ),
    )
    .orderBy(asc(recoveryMetrics.date));
  const recoveryByDate = new Map<
    string,
    {
      values: Partial<Record<(typeof RECOVERY_METRIC_KEYS)[number], number>>;
      rank: Record<string, number>;
    }
  >();
  for (const r of recoveryRows) {
    const key = r.metric as (typeof RECOVERY_METRIC_KEYS)[number];
    const day = recoveryByDate.get(r.date) ?? { values: {}, rank: {} };
    const rank = RECOVERY_SOURCE_PRIORITY.indexOf(r.source);
    const sourceRank = rank === -1 ? RECOVERY_SOURCE_PRIORITY.length : rank;
    const current = day.rank[key];
    if (current === undefined || sourceRank < current) {
      day.values[key] = r.value;
      day.rank[key] = sourceRank;
    }
    recoveryByDate.set(r.date, day);
  }
  const recovery = [...recoveryByDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, day]) => ({
      date,
      restingHr: day.values.resting_hr ?? null,
      hrv: day.values.hrv_rmssd ?? null,
      sleepHours: day.values.sleep_hours ?? null,
      bodyBattery: day.values.body_battery ?? null,
    }));

  // Exposure heatmap: this ISO week, from ACTUAL analyses only (what was really done).
  const weekStart = isoWeekStart(today);
  const weekEnd = isoWeekEnd(today);
  const analysisRows = await db
    .select({
      date: workoutAnalyses.date,
      patternExposure: workoutAnalyses.patternExposure,
      muscleExposure: workoutAnalyses.muscleExposure,
    })
    .from(workoutAnalyses)
    .where(
      and(
        eq(workoutAnalyses.userId, userId),
        eq(workoutAnalyses.phase, "actual"),
        gte(workoutAnalyses.date, weekStart),
        lte(workoutAnalyses.date, weekEnd),
      ),
    );
  const exposed: ExposedSession[] = analysisRows.map((a) => ({
    date: a.date,
    patternExposure: a.patternExposure,
    muscleExposure: a.muscleExposure,
  }));

  return {
    range,
    from,
    to,
    volume: weeks.map((weekStart) => ({
      weekStart,
      minutes: Math.round(volumeByWeek.get(weekStart) ?? 0),
    })),
    distribution: weeks.map((weekStart) => {
      const b = distByWeek.get(weekStart);
      return {
        weekStart,
        crossfit: Math.round(b?.crossfit ?? 0),
        strength: Math.round(b?.strength ?? 0),
        easyEndurance: Math.round(b?.easyEndurance ?? 0),
        hardEndurance: Math.round(b?.hardEndurance ?? 0),
        recovery: Math.round(b?.recovery ?? 0),
      };
    }),
    strength,
    engine: {
      paceAtHr,
      thresholdPace,
      tests: testRows.map((t) => ({
        date: t.date,
        testKey: t.testKey,
        value: t.value,
        unit: t.unit,
      })),
    },
    crossfit: {
      benchmarks: benchmarkRows.map((b) => ({
        benchmarkId: b.benchmarkId,
        name: b.name,
        date: b.date,
        score: `${formatBenchmarkScore(b.scoreKind, b.scoreValue)}${b.rx ? " Rx" : ""}`,
      })),
      prs,
    },
    recovery,
    enjoyment,
    load: { daily, acute7d, chronicWeeklyAvg, ratio },
    heatmap: {
      patterns: weeklyPatternHeatmap(exposed, weekStart, weekEnd),
      muscles: weeklyMuscleHeatmap(exposed, weekStart, weekEnd),
    },
  };
}
