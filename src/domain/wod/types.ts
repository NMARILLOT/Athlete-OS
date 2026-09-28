import type {
  EnergySystem,
  IntensityBand,
  LoadVector,
  Modality,
  MuscleExposure,
  PatternExposure,
  StimulusCredits,
} from "../core";

export type TimeDomain = "short" | "medium" | "long";
export type WodDominant = "strength" | "hypertrophy" | "skill" | "conditioning" | "mixed";

export interface MovementTotals {
  exerciseId: string | null;
  name: string;
  totalReps: number;
  totalDistanceM: number;
  totalCalories: number;
  totalDurationSec: number;
  loadKg: number | null;
  /** Work units used by the analyzer (reps-equivalent). */
  workUnits: number;
}

export interface WodAnalysis {
  algorithmVersion: string;
  estimatedDurationMin: number;
  /** Duration of the metcon portion(s) only. */
  metconMinutes: number;
  timeDomain: TimeDomain;
  dominant: WodDominant;
  intensity: IntensityBand;
  intensityReason: string;
  /** True when the metcon uses high-rate movements at light loads (drives the hard classification). */
  highRate: boolean;
  energySystems: EnergySystem[];
  modalities: Modality[];
  patternExposure: PatternExposure;
  muscleExposure: MuscleExposure;
  loadVector: LoadVector;
  impactUnits: number;
  stimulusCredits: StimulusCredits;
  movements: MovementTotals[];
  tags: string[];
  unknownMovements: string[];
  /** 0..1 — lowered by unknown movements and unparseable quantities. */
  confidence: number;
  warnings: string[];
}
