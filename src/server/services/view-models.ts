/**
 * View models returned by services to screens. Kept free of DB types so components and stores
 * can import them (they live in src/server but contain only plain data shapes).
 */
import type { Recommendation } from "@/domain/engine";
import type { WodAnalysis, NormalizedWod } from "@/domain/wod";
import type { IntensityBand, WorkoutStatus, WorkoutType } from "@/domain/core";

export interface WorkoutCard {
  id: string;
  date: string;
  type: WorkoutType;
  status: WorkoutStatus;
  title: string;
  kind: string | null;
  family: string | null;
  startMinute: number | null;
  durationMin: number | null;
  intensity: IntensityBand | null;
  fixed: boolean;
  rpe: number | null;
  feeling: string | null;
  source: string;
  /** Outlook-only cards have no workout row yet. */
  projected?: boolean;
}

export interface ReadinessDeclaredView {
  date: string;
  energy: number;
  soreness: number;
  motivation: number;
  unusualPain: boolean;
}

export interface TodayView {
  date: string;
  displayName: string | null;
  baselinePhase: boolean;
  recommendation: Recommendation | null;
  recommendationId: string | null;
  workouts: WorkoutCard[];
  readiness: ReadinessDeclaredView | null;
  activeIntentKind: string | null;
  /** In-progress strength workout (from the server replica) so Today can offer "Reprendre". */
  inProgressWorkoutId: string | null;
  insight: string | null;
  onboardingDone: boolean;
}

export interface InboxItemView {
  id: string;
  createdAt: string;
  status: "new" | "parsed" | "needs_review" | "confirmed" | "discarded";
  rawText: string | null;
  parseSource: string | null;
  parseConfidence: number | null;
  normalizedWod: NormalizedWod | null;
  analysis: WodAnalysis | null;
  scheduledFor: string | null;
  startLocal: string | null;
  workoutId: string | null;
  lastError: string | null;
}

export interface CalendarDayView {
  date: string;
  workouts: WorkoutCard[];
  outlook: {
    kind: string;
    title: string;
    intensity: IntensityBand;
    durationMin: number;
    family: string;
  } | null;
  bonus: { kind: string; title: string } | null;
  isToday: boolean;
}

export interface CalendarWeekView {
  weekStart: string;
  days: CalendarDayView[];
  weekOutlookDate: string | null;
}

export interface StrengthSetView {
  id: string;
  setIndex: number;
  reps: number | null;
  weightKg: number | null;
  rpe: number | null;
  quality: string | null;
  isWarmup: boolean;
  completedAt: string;
  e1rmKg: number | null;
}

export interface ExercisePageView {
  exerciseId: string;
  name: string;
  currentE1rmKg: number | null;
  recentPrKg: number | null;
  bestPrKg: number | null;
  lastExposure: string | null;
  weeklySets: number;
  recentLoads: Array<{ date: string; weightKg: number; reps: number; e1rmKg: number | null }>;
  history: Array<{ date: string; workoutId: string; sets: StrengthSetView[] }>;
}

export interface ProgressView {
  range: string;
  from: string;
  to: string;
  volume: Array<{ weekStart: string; minutes: number }>;
  distribution: Array<{
    weekStart: string;
    crossfit: number;
    strength: number;
    easyEndurance: number;
    hardEndurance: number;
    recovery: number;
  }>;
  strength: Array<{
    exerciseId: string;
    name: string;
    points: Array<{ date: string; e1rmKg: number }>;
  }>;
  engine: {
    paceAtHr: Array<{ date: string; paceSecKm: number; hrBand: string }>;
    thresholdPace: Array<{ date: string; paceSecKm: number }>;
    tests: Array<{ date: string; testKey: string; value: number; unit: string }>;
  };
  crossfit: {
    benchmarks: Array<{ benchmarkId: string; name: string; date: string; score: string }>;
    prs: Array<{
      exerciseId: string;
      name: string;
      value: number;
      unit: string;
      date: string;
      estimated: boolean;
    }>;
  };
  recovery: Array<{
    date: string;
    restingHr: number | null;
    hrv: number | null;
    sleepHours: number | null;
    bodyBattery: number | null;
  }>;
  enjoyment: Array<{ date: string; fun: number }>;
  load: {
    daily: Array<{ date: string; load: number }>;
    acute7d: number;
    chronicWeeklyAvg: number;
    ratio: number | null;
  };
  heatmap: {
    patterns: Array<{ key: string; bars: number; value: number }>;
    muscles: Array<{ key: string; bars: number; value: number }>;
  };
}
