import {
  MOVEMENT_PATTERN_VALUES,
  MUSCLE_GROUP_VALUES,
  type MovementPattern,
  type MuscleExposure,
  type MuscleGroup,
  type PatternExposure,
} from "../core";
import { daysBetween, type IsoDate } from "../core/dates";

export interface ExposedSession {
  date: IsoDate;
  patternExposure: PatternExposure;
  muscleExposure: MuscleExposure;
}

/** Weighted pattern exposure over the last 72 h: today 1.0, yesterday 0.6, two days ago 0.3. */
export function patternExposure72h(sessions: readonly ExposedSession[], today: IsoDate): PatternExposure {
  const weights = [1, 0.6, 0.3];
  const out: PatternExposure = {};
  for (const s of sessions) {
    const d = daysBetween(s.date, today);
    if (d < 0 || d > 2) continue;
    const w = weights[d] as number;
    for (const [p, v] of Object.entries(s.patternExposure) as Array<[MovementPattern, number]>) {
      out[p] = (out[p] ?? 0) + v * w;
    }
  }
  return out;
}

export interface HeatmapRow<K extends string> {
  key: K;
  value: number;
  /** 0..5 bars for the UI (spec §48), relative to a reference "full week" exposure. */
  bars: number;
}

/**
 * Reference exposure for a "well-covered" week per pattern/muscle (5 bars). Values are exposure
 * units summed from the analyzer (≈ one heavy compound session contributes ~3 to its main pattern).
 */
const PATTERN_REF: Record<MovementPattern, number> = {
  squat: 8,
  hinge: 7,
  horizontal_push: 6,
  vertical_push: 6,
  horizontal_pull: 6,
  vertical_pull: 6,
  carry: 3,
  locomotion: 10,
  rotation_core: 6,
  olympic_lift: 5,
  gymnastics: 6,
  isolation: 4,
};
const MUSCLE_REF: Record<MuscleGroup, number> = {
  quads: 10,
  hamstrings: 8,
  glutes: 10,
  calves: 6,
  hip_flexors: 4,
  adductors: 4,
  lower_back: 6,
  core: 8,
  chest: 6,
  upper_back: 8,
  lats: 7,
  shoulders: 8,
  traps: 5,
  biceps: 4,
  triceps: 5,
  forearms_grip: 6,
};

function bars(value: number, ref: number): number {
  return Math.max(0, Math.min(5, Math.round((value / ref) * 5)));
}

export function weeklyPatternHeatmap(sessions: readonly ExposedSession[], from: IsoDate, to: IsoDate): HeatmapRow<MovementPattern>[] {
  const sum: PatternExposure = {};
  for (const s of sessions) {
    if (s.date < from || s.date > to) continue;
    for (const [p, v] of Object.entries(s.patternExposure) as Array<[MovementPattern, number]>) sum[p] = (sum[p] ?? 0) + v;
  }
  return MOVEMENT_PATTERN_VALUES.map((p) => ({ key: p, value: round2(sum[p] ?? 0), bars: bars(sum[p] ?? 0, PATTERN_REF[p]) }));
}

export function weeklyMuscleHeatmap(sessions: readonly ExposedSession[], from: IsoDate, to: IsoDate): HeatmapRow<MuscleGroup>[] {
  const sum: MuscleExposure = {};
  for (const s of sessions) {
    if (s.date < from || s.date > to) continue;
    for (const [m, v] of Object.entries(s.muscleExposure) as Array<[MuscleGroup, number]>) sum[m] = (sum[m] ?? 0) + v;
  }
  return MUSCLE_GROUP_VALUES.map((m) => ({ key: m, value: round2(sum[m] ?? 0), bars: bars(sum[m] ?? 0, MUSCLE_REF[m]) }));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
