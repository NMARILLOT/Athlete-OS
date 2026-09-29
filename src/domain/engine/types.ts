import type {
  Confidence,
  Equipment,
  GoalWeights,
  IntensityBand,
  LoadDimension,
  LoadVector,
  Modality,
  PatternExposure,
  StimulusCredits,
  StimulusKey,
  TimeWindow,
  UserIntent,
  WorkoutType,
  ActivePain,
} from "../core";
import type { IsoDate, IsoDateTime } from "../core/dates";
import type { AthleteModelParams } from "../athlete-model";
import type { Ledger, StimulusTargets } from "../stimulus";

export const ENGINE_VERSION = "engine_v1.0" as const;

/** Shared load description for candidates, planned sessions and history (ENGINE.md §1). */
export interface LoadProfile {
  expectedCredits: StimulusCredits;
  loadVector: LoadVector;
  intensity: IntensityBand;
  heavyStrength: boolean;
  durationMin: number;
  modality: Modality;
  patterns: PatternExposure;
  impactUnits: number;
}

export interface HistorySession extends LoadProfile {
  id: string;
  date: IsoDate;
  /** ISO datetime the session ended (start + duration when unknown). */
  endTime: IsoDateTime;
  type: WorkoutType;
  kind?: string | null;
  family?: string | null;
  /** Display title of the session as the athlete named it (falls back to the catalog title). */
  title?: string | null;
  rpe?: number | null;
  funScore?: number | null;
  sessionRpeLoad?: number | null;
  /** True when credits/load come from a prior or template only (no RPE, no analysis). */
  estimated: boolean;
}

export type WodStatus = "none" | "confirmed" | "parsed" | "needs_review";

export interface PlannedSession {
  id: string;
  date: IsoDate;
  type: WorkoutType;
  title: string;
  startMinute?: number | null;
  /** Fixed = class time / coaching / event: the engine plans around it, never removes it. */
  fixed: boolean;
  status: "planned" | "in_progress";
  kind?: string | null;
  family?: string | null;
  /** Null when the WOD is unknown (fixed class without a gated-in analysis). */
  profile: LoadProfile | null;
  wodStatus?: WodStatus;
  wodConfidence?: number | null;
}

export interface ReadinessSnapshot {
  band: "good" | "ok" | "poor";
  hasDeclared: boolean;
  hasMeasured: boolean;
  signals: string[];
}

export interface EngineEvent {
  kind: string;
  date: IsoDate;
  priority: "A" | "B" | "C";
  taperDays: number;
  name?: string;
}

export interface EngineInput {
  now: IsoDateTime;
  today: IsoDate;
  profile: {
    goalWeights: GoalWeights;
    targets: StimulusTargets;
    baselinePhase: boolean;
    maxHardSessionsPerWeek: number;
    weeklyHoursTarget: number;
    preferences: { favouriteModalities: Modality[]; dislikedModalities: Modality[] };
    equipmentAvailable: Equipment[];
  };
  history: HistorySession[];
  planned: PlannedSession[];
  readiness?: ReadinessSnapshot | null;
  pain: ActivePain[];
  intents: UserIntent[];
  availability?: { windows: TimeWindow[]; totalMinutes: number } | null;
  athleteModel: AthleteModelParams;
  deload?: { active: boolean; reason?: string; until?: IsoDate } | null;
  events?: EngineEvent[];
  lastTestDates?: Partial<Record<string, IsoDate>>;
  /** Learned per-weekday box priors (0 = Monday) — optional, from athlete model. */
  boxPriorByWeekday?: Partial<Record<number, { profile: LoadProfile; confidence: number }>>;
}

// ---------------------------------------------------------------------------
// Candidates and rules
// ---------------------------------------------------------------------------

export type CandidateOrigin =
  "catalog" | "crossfit_as_programmed" | "crossfit_generic" | "intent" | "done_today" | "placement";

export interface Candidate extends LoadProfile {
  kind: string;
  family: string;
  title: string;
  equipment: Equipment[];
  recovery: boolean;
  isTest?: boolean;
  testKey?: string;
  origin: CandidateOrigin;
  timeOfDay?: "morning" | "midday" | "evening";
  /** Confidence of the profile itself (prior = 0.4). */
  profileConfidence: number;
  plannedId?: string;
  fixed?: boolean;
  templateId?: string;
}

export type RuleKind = "safety" | "balance" | "preference";
export type RuleEffect = "veto" | "score" | "note";

export interface RuleOutcome {
  ruleId: string;
  kind: RuleKind;
  effect: RuleEffect;
  score?: number;
  message: string;
  data?: Record<string, unknown>;
}

export interface RuleHit extends RuleOutcome {
  /** Candidate kind the outcome applied to; undefined for global notes. */
  candidateKind?: string;
}

export interface ScoredCandidate {
  candidate: Candidate;
  coverage: number;
  interference: number;
  recovery: number;
  ruleScore: number;
  score: number;
  vetoed: boolean;
  outcomes: RuleOutcome[];
  coveredKeys: StimulusKey[];
}

// ---------------------------------------------------------------------------
// Derived context
// ---------------------------------------------------------------------------

export interface DerivedContext {
  input: EngineInput;
  today: IsoDate;
  now: IsoDateTime;
  weekday: number;
  remainingDays: number;
  residual: LoadVector;
  fatigueRatio: Record<LoadDimension, number>;
  maxFatigueRatio: number;
  contributing: Record<
    LoadDimension,
    Array<{ id: string; date: IsoDate; contribution: number; kind?: string | null }>
  >;
  pattern72h: PatternExposure;
  ledger: Ledger;
  hardDone6d: number;
  hardYesterday: boolean;
  hardFixedNext3d: number;
  hardFixedTomorrow: boolean;
  fixedClassesThisWeek: number;
  hardBudgetRemaining: number;
  heavyStrength7d: number;
  impact7dIU: number;
  impactToleranceIU: number;
  polarisation14d: { hardMin: number; moderateMin: number; easyMin: number; totalMin: number };
  consecutiveTrainingDays: number;
  restDaysThisWeek: number;
  doneToday: HistorySession[];
  primaryDoneToday: HistorySession | null;
  doublesThisWeek: number;
  dayLoadDoneAU: number;
  dailyLoadCapAU: number;
  todayFixed: PlannedSession[];
  todayPlannedFree: PlannedSession[];
  tomorrowFixed: PlannedSession[];
  tomorrowDemand: LoadProfile | null;
  tomorrowDemandSource: "analysis" | "prior" | "none";
  todayClassUnknown: boolean;
  tomorrowClassUnknown: boolean;
  readinessBand: "good" | "ok" | "poor" | "unknown";
  fresh: boolean;
  deloadActive: boolean;
  baselinePhase: boolean;
  intent: UserIntent | null;
  availableMinutes: number;
  largestWindowMin: number;
  eventWithinTaper: EngineEvent | null;
  daysSinceLastTest: number | null;
  estimatedShare: number;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface Option extends LoadProfile {
  kind: string;
  family: string;
  title: string;
  origin: CandidateOrigin;
  timeOfDay?: "morning" | "midday" | "evening";
  templateId?: string;
  plannedId?: string;
  fixed?: boolean;
  isTest?: boolean;
  testKey?: string;
  score: number;
  reason: string;
}

export type BonusDecision = Option | { kind: "none"; reason: string };

export function isBonusOption(b: BonusDecision): b is Option {
  return b.kind !== "none" && "intensity" in b;
}

export interface Reschedule {
  plannedId: string;
  fromDate: IsoDate;
  toDate: IsoDate | null;
  reason: string;
}

export type AdviceCode = "SCALE_ADVICE" | "MEDICAL_ADVICE" | "MISSING_RPE";
export type AskFor = "wod" | "wod_review" | "readiness" | "rpe";

export interface ConfidenceResult {
  level: Confidence;
  score: number;
  components: Record<string, number>;
}

export interface EngineTrace {
  derived: {
    residual: LoadVector;
    fatigueRatio: Record<LoadDimension, number>;
    hardDone6d: number;
    hardFixedNext3d: number;
    hardBudgetRemaining: number;
    heavyStrength7d: number;
    impact7dIU: number;
    impactToleranceIU: number;
    consecutiveTrainingDays: number;
    restDaysThisWeek: number;
    readinessBand: string;
    fresh: boolean;
    deloadActive: boolean;
    topGaps: Array<{ key: StimulusKey; projectedGap: number; urgency: number }>;
    tomorrowDemandSource: string;
  };
  candidates: Array<{
    kind: string;
    score: number;
    coverage: number;
    interference: number;
    recovery: number;
    ruleScore: number;
    vetoed: boolean;
    outcomes: Array<{ ruleId: string; effect: RuleEffect; score?: number }>;
  }>;
}

export interface Recommendation {
  date: IsoDate;
  engineVersion: string;
  primary: Option;
  primaryDone: boolean;
  bonus: BonusDecision;
  alternatives: Option[];
  reschedules: Reschedule[];
  advice: Array<{ code: AdviceCode; text: string }>;
  askFor: AskFor[];
  deloadProposal?: { reason: string; signals: string[]; until: IsoDate } | null;
  explanation: string;
  confidence: ConfidenceResult;
  rulesTriggered: RuleHit[];
  trace: EngineTrace;
  /** Filled by projectWeek when the service asks for it. */
  weekOutlook?: DayOutlook[];
}

export interface DayOutlook {
  date: IsoDate;
  primary: Option;
  bonus: BonusDecision;
  fixed: PlannedSession[];
  confidence: Confidence;
  rulesTriggered: string[];
  explanation: string;
}

export interface PlacementVerdict {
  date: IsoDate;
  verdict: "ok" | "warn" | "veto";
  outcomes: RuleOutcome[];
  summary: string;
}
