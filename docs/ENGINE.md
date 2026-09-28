# Athlete OS — Adaptive engine (Layer A) and AI (Layer B) — v2

> v2 integrates the adversarial architecture review (scoring normalisation, hard-budget definition, unknown-WOD
> class handling, bonus gating, confidence model, week projection). Constants live in code:
> `src/domain/athlete-model/defaults.ts` is the single source of numeric defaults; this document explains them.

## 0. Contract (pure, deterministic, versioned)

```ts
runEngine(input: EngineInput): Recommendation            // one day
projectWeek(input: EngineInput, days = 7): DayOutlook[]  // fold runEngine day by day, primaries appended to a simulated history
checkPlacement(input: EngineInput, session: LoadProfile, targetDate): PlacementVerdict  // "this session on that date?"
```

The engine never reads the database or the clock; the service layer assembles `EngineInput` and passes `now`.
Everything it decides is reproducible from the persisted `inputs_snapshot`. `ENGINE_VERSION` is bumped whenever
a rule, constant or contract changes behaviour.

**The engine never inserts `workouts` rows.** The week outlook is stored in `recommendations.output.weekOutlook`
and rendered by the Calendar as grey "prévu" cards; a day becomes a real planned workout only when the user pins it.

## 1. Inputs

```ts
interface LoadProfile {                 // shared by Candidate, PlannedSession, HistorySession
  expectedCredits: StimulusCredits;     // or actual credits for history
  loadVector: LoadVector;               // 0..10 per dimension
  intensity: IntensityBand;             // metabolic axis (domain/load/intensity.ts)
  heavyStrength: boolean;               // any compound set at RPE ≥ 8
  durationMin: number;
  modality: Modality;
  patterns: PatternExposure;
  impactUnits: number;
}

interface EngineInput {
  now: IsoDateTime; today: IsoDate;
  profile: {
    goalWeights: GoalWeights;
    targets: StimulusTargets;                  // deriveWeeklyTargets(...) — already budget-consistent
    baselinePhase: boolean;
    maxHardSessionsPerWeek: number;            // default 3
    weeklyHoursTarget: number;
    preferences: { favouriteModalities: Modality[]; dislikedModalities: Modality[] };
    equipmentAvailable: Equipment[];           // athlete_profiles.equipment, overridden by an active travel period
  };
  history: HistorySession[];                   // done sessions, last 28 days INCLUDING today (doneToday derived)
  planned: PlannedSession[];                   // today..+7, { id, date, startMinute?, fixed, status, wodStatus, profile: LoadProfile | null }
  crossfitToday?: { profile: LoadProfile; confidence: number; source: 'confirmed' | 'blended' | 'prior' };
  readiness?: ReadinessSnapshot;               // declared (energy, soreness, motivation) + measured deviations + band
  pain: ActivePain[];
  intents: UserIntent[];                       // active today (day-scoped first)
  availability?: { windows: TimeWindow[]; totalMinutes: number };
  athleteModel: AthleteModelParams;            // half-lives, tolerances, cost multipliers, impact tolerance, mean daily load
  deload?: { active: boolean; reason?: string; until?: IsoDate };   // active training block with focus = recovery
  events: { kind; date; priority; taperDays }[];
  lastTestDates: Partial<Record<TestKey, IsoDate>>;
}
```

### Gate for CrossFit analyses (Layer B never steers Layer A)
A `WodAnalysis` becomes `crossfitToday` / `tomorrowDemand` only if the inbox item is **confirmed** or
`parseConfidence ≥ 0.7`. Between 0.5 and 0.7 it is blended 50/50 with the class prior and confidence is capped at
MEDIUM. Below 0.5 the prior is used and `askFor` contains `wod_review`.

## 2. Derived state (all explainable, all in the trace)

| Quantity                    | Definition                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `residual[dim]`             | `Σ load[dim] × 0.5^(hoursSince / halfLife[dim])` over history (today's done sessions included)                                   |
| `fatigueRatio[dim]`         | `residual[dim] / tolerance[dim]` — ≥ 1 means a same-dimension heavy stimulus is vetoed                                           |
| `contributing[dim]`         | top-3 sessions by residual contribution (for "3 gros stimuli jambes en 4 jours")                                                 |
| `pattern72h`                | weighted pattern exposure (1 / 0.6 / 0.3)                                                                                        |
| `ledger`                    | `computeLedger` — rolling windows per key, `plannedFixedCredits`, `gap`, `projectedGap`, `stalenessDays`, `urgency`              |
| `hardDone6d`                | sessions with `intensity = hard` in the trailing 6 days (metcons included, heavy strength excluded)                              |
| `hardFixedNext3d`           | fixed planned sessions in the next 3 days that are hard (unknown-WOD class counts as hard)                                       |
| `hardBudgetRemaining`       | `maxHard − hardDone6d − hardFixedNext3d` (baseline: engine-proposed hard = `max(0, 2 − fixedClassesThisWeek)`)                   |
| `heavyStrength7d`           | sessions with `heavyStrength = true` in 7 days (budget ≤ 3)                                                                      |
| `impact7dIU`                | Σ impact units over 7 days vs `athleteModel.impactWeeklyToleranceIU`                                                             |
| `polarisation14d`           | minutes hard / moderate / easy over 14 days of cardio+metcon work                                                                |
| `consecutiveTrainingDays`   | days with a non-rest session ending today                                                                                        |
| `restDaysThisWeek`          | days of the ISO week (Mon→today) with no session or only mobility                                                                |
| `doneToday`                 | history sessions dated today; if any is primary-level (not mobility/walk), only bonus/recovery candidates are evaluated          |
| `doublesThisWeek`           | days this week with ≥ 2 non-mobility sessions                                                                                    |
| `tomorrowDemand`            | load profile of tomorrow's fixed session: its analysis if gated in, else the class prior                                         |
| `readinessBand`             | `good | ok | poor` — poor requires ≥ 2 signals (≥ 1 declared or ≥ 2 measured); thresholds in defaults.ts                          |
| `dailyLoadCap`              | `max(500, 1.3 × meanDailyLoadAU)`                                                                                                |
| `fresh`                     | all `fatigueRatio ≤ 0.4`, readiness good, no hard in 48 h, no test in 14 d                                                       |
| `fatigueSignals`            | count of deload signals (see §8)                                                                                                 |

## 3. Candidate generation

Catalog in `domain/engine/candidates.ts`, each candidate is a `LoadProfile` + `{ kind, title, timeOfDay?, equipment, family }`.
Reference load vectors come from `REFERENCE_LOAD`.

- Strength: `strength_lower`, `strength_upper`, `strength_full`, `accessory_upper`, `olympic_technique`, `gymnastics_skill`
- Easy endurance: `run_easy_45`, `run_easy_60`, `run_long_90`, `bike_easy_60`, `bike_long_120`, `row_easy_30`, `ski_easy_30`, `walk_45`
- Hard endurance: `run_tempo`, `run_threshold`, `run_vo2`, `strides`, `bike_intervals`, `row_intervals`
- Recovery: `mobility_20`, `recovery_spin_30`, `rest`
- Tests: `test_run_5k`, `test_row_2k` (only when `fresh`)
- CrossFit — **generated, not catalog**: `crossfit_as_programmed` when a fixed class exists today with a gated-in analysis;
  `crossfit_generic` (static prior, confidence 0.4, or the learned weekday box prior when its confidence ≥ 0.5) when a fixed
  class exists today without one. Never proposed on a day without a class.
- Intent families (composite, credits summed, loads max-merged): `hyrox_{easy,moderate,hard}`, `partner_wod_{easy,hard}`,
  `run_{easy,tempo,hard}`, `bike_{easy,long,hard}`, `benchmark_attempt`, `just_move_20`.

Candidates are filtered by equipment and availability before scoring.

## 4. Rules (Layer A) — v1.0 set

A rule is `{ id, kind: 'safety' | 'balance' | 'preference', evaluate(ctx, candidate?) → RuleOutcome | null }`,
`RuleOutcome = { effect: 'veto' | 'score' | 'note', score?: number, message: string, data?: object }`.
Score scale is fixed: safety −4, balance ±3, preference ±2, intent +6 (partial +3), variety −2..+1. Only safety rules veto.

| id                                   | kind       | v1.0 logic                                                                                                                              |
| ------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `HIGH_LOWER_BODY_FATIGUE`            | safety     | `fatigueRatio.muscular_lower ≥ 1` → veto candidates with `muscular_lower ≥ 6`; the interference term handles the gradient (no extra penalty) |
| `HIGH_UPPER_BODY_FATIGUE`            | safety     | same for upper                                                                                                                          |
| `HIGH_CARDIO_FATIGUE`                | safety     | `fatigueRatio.cardiovascular ≥ 1` → veto `intensity = hard`                                                                             |
| `HIGH_IMPACT_LOAD`                   | safety     | `impact7dIU > tolerance` or `fatigueRatio.impact ≥ 1` → veto candidates with `impact ≥ 5`; −3 on running above 0.8 × tolerance          |
| `HARD_SESSION_BUDGET_EXCEEDED`       | safety     | `hardBudgetRemaining ≤ 0` → veto engine-proposed hard candidates (fixed classes are never vetoed by budget)                             |
| `HEAVY_STRENGTH_BUDGET`              | safety     | `heavyStrength7d ≥ 3` → veto heavy strength candidates                                                                                  |
| `HARD_EASY_ALTERNATION`              | balance    | −3 on hard if hard yesterday or fixed hard tomorrow                                                                                     |
| `PATTERN_REPEAT_72H`                 | balance    | −2 when the candidate's dominant pattern (squat vs hinge vs push vs pull) already ≥ 3 in `pattern72h`                                   |
| `TOMORROW_HEAVY_CONFLICT`            | balance    | −3 on candidates whose region load ≥ 6 when `tomorrowDemand` loads the same region ≥ 6                                                  |
| `FIXED_CLASS_RESERVE`                | balance    | class today/tomorrow with unknown WOD → −3 on `muscular_lower ≥ 6` or hard candidates; one hard slot reserved                            |
| `CROSSFIT_COVERS_STIMULUS`           | balance    | today's class credits a key ≥ 0.8 → −3 on candidates duplicating it; `note` "couvre ton stimulus X"                                     |
| `READINESS_POOR`                     | safety     | band poor → veto hard; −2 moderate; note. Never fires on a single noisy metric                                                            |
| `PAIN_ACTIVE`                        | safety     | pain ≥ 4 → veto candidates involving flagged movements/patterns; ≥ 7 or sudden+persistent → `MEDICAL_ADVICE` advice                       |
| `WEEKLY_GAP_PRIORITY`                | balance    | expressed by the coverage term (documented here for explanations: top gaps are named)                                                    |
| `PROTECT_EASY_VOLUME`                | balance    | 14-day window, ≥ 90 cardio minutes: −3 on hard if hard share > 25 %; −2 on moderate if moderate share > 15 %; skipped when budget vetoed |
| `WEEKLY_RECOVERY_DAY`                | safety     | `consecutiveTrainingDays ≥ 6` → veto hard, +6 recovery; balance: no rest day yet and `remainingDays ≤ 2` → +4 recovery                  |
| `LONG_SESSION_PLACEMENT`             | balance    | long aerobic only with ≥ 90 min window and no hard yesterday (else −3); on a weekday with no known ≥ 90 min window and no intent asking, −6 (long sessions default to the weekend) |
| `STALENESS`                          | balance    | candidate's primary stimulus not credited within its window: +2 (never in 42 d also +2), +3 when last credit > 1.5 × window ago       |
| `HEAVY_STRENGTH_BUDGET`              | safety     | `heavyStrength7d ≥ 3` → veto heavy strength candidates                                                                                  |
| `DELOAD_ACTIVE`                      | safety     | veto VO2/benchmarks/tests; strength allowed at RPE ≤ 7 with sets × 0.6 (prescription note); impact tolerance × 0.5                        |
| `BASELINE_PHASE_CONSERVATIVE`        | safety     | engine-proposed hard ≤ `max(0, 2 − fixedClassesThisWeek)`; no doubles; confidence ≤ MEDIUM                                              |
| `INTENT_RESPECT`                     | preference | +6 exact family match, +3 partial (same modality, other intensity)                                                                       |
| `INTENT_DECLINED_WITH_ALTERNATIVE`   | note       | fired when every exact-match candidate is vetoed → nearest safe variant promoted, explanation names the vetoing rule                      |
| `PLAN_ADHERENCE`                     | preference | +3 to today's planned non-fixed session so the plan is stable but intent (+6) beats it                                                   |
| `VARIETY`                            | preference | −2 same kind three days running; +1 favourite modality; −2 disliked                                                                     |
| `AVAILABILITY_FIT`                   | safety     | duration > largest window → veto (shorter variant substituted when one exists)                                                            |
| `TEST_OPPORTUNITY`                   | balance    | `fresh` and a goal needs the test → +3 on the test candidate                                                                             |
| `EVENT_TAPER`                        | safety     | event within `taperDays` → veto hard non-specific, +3 specific easy                                                                      |
| `RESCHEDULE_SUGGESTED`               | note       | today's planned non-fixed session displaced by intent or veto → `reschedules[]` entry                                                    |

## 5. Scoring (normalised, every term bounded)

```
w_k         = stimulusWeight(k, goalWeights)                       // 0.5..1.5 (affinity matrix, floor 0.5 = spec §36)
coverage(c) = min(15, Σ_k min(credit_c[k], projectedGap[k]) × w_k × urgency_k × 10)
interfere(c)= min(12, Σ_dim (load_c[dim] / 10) × min(fatigueRatio[dim], 1.5) × 3)
recovery(c) = for c ∈ {rest, mobility_20, recovery_spin_30, walk_45}:
              10 × clamp((maxFatigueRatio − 0.6) / 0.6, 0, 1) + {poor: 5, ok: 2, good: 0}[readiness] + (consecutiveTrainingDays ≥ 5 ? 4 : 0)
              (recovery candidates get NO coverage term)
score(c)    = coverage − interfere + recovery + Σ ruleScores
```

Expected orderings (golden tests): §99-2 fresh + vo2 gap → `run_vo2` > `run_easy` > `rest`; day after squat + AMRAP →
`accessory_upper` ≈ `rest` > `run_easy` and no heavy lower; §33 Hyrox → hard family vetoed, `hyrox_easy` promoted.

## 6. Selection and output

1. **Fixed session today** → it is the primary. Safety vetoes against it are converted into `SCALE_ADVICE`
   ("garde la classe, allège les squats"), never a removal. Bonus evaluated per §7.
2. **Primary-level session already done today** → `primaryDone = true`, primary = that session, only bonus/recovery evaluated.
3. Otherwise primary = best non-vetoed candidate. If that is a recovery candidate → "Rien aujourd'hui. Récupère." wording.
4. Alternatives = next 2–3 non-vetoed candidates of different families than the primary (3 when confidence is LOW).
5. Reschedule: if today's planned non-fixed session is not the primary, `reschedule(planned, week)` = earliest later day
   this week that is not vetoed, ≥ 48 h from a same-region heavy exposure and not the day before a fixed class heavy in that
   region; else next week. Emits `RESCHEDULE_SUGGESTED`.
6. Explanation: French, ≤ 2 sentences, templated from the top fired rules + top gap + `contributing` sessions.
7. Confidence (§9). Trace: derived state, every candidate's score breakdown, every rule hit.

```ts
interface Recommendation {
  date; engineVersion;
  primary: Option; primaryDone: boolean;
  bonus: Option | { kind: 'none'; reason: string };
  alternatives: Option[];                          // ≤ 3
  reschedules: { plannedId; fromDate; toDate; reason }[];
  advice: { code: 'SCALE_ADVICE' | 'MEDICAL_ADVICE' | 'MISSING_RPE'; text }[];
  askFor: ('wod' | 'wod_review' | 'readiness' | 'rpe')[];
  deloadProposal?: { reason; signals: string[]; until: IsoDate };
  explanation: string;
  confidence: { level: Confidence; score: number; components: Record<string, number> };
  rulesTriggered: RuleHit[];
  trace: EngineTrace;
}
interface Option extends LoadProfile { kind: SessionKind | string; family: string; title: string; timeOfDay?: 'morning' | 'midday' | 'evening'; prescriptionRef?: { templateId?: string; cardioSteps?: CardioStep[] }; score: number; reason: string }
```

## 7. Bonus (double session) gate — evaluated on the BONUS candidate, never on the primary

```
bonus allowed iff  bonus.intensity = easy
               AND every bonus load dim ≤ 3 AND (bonus.impact ≤ 2 OR primary.impact = 0)
               AND ∃ key k covered by bonus with projectedGap[k] ≥ 0.8 AND projectedGap[k] > freeDaysRemaining × 0.8
               AND gap between sessions ≥ 4 h (≥ 6 h when primary is hard) AND both fit availability
               AND dayLoad(primary + bonus) ≤ dailyLoadCap AND maxFatigueRatio ≤ 0.6 AND readiness ≠ poor
               AND doublesThisWeek < maxDoubles (2) AND NOT baselinePhase AND NOT deload
```
Ordering: with an evening class, an easy morning bonus is placed before it only if the class prior/analysis is not
lower-body heavy; after a hard class only ≤ 30 min Z2 / mobility; unknown-WOD class → bonus ≤ 20 min, confidence ≤ MEDIUM.
`have_time` only widens availability. Refusals carry `{ kind: 'none', reason }` for the UI.

## 8. Deload (spec §42) — `evaluateDeload(history28d, readinessTrend, pain, fun, events)`

Signals: load ratio > 1.3 two weeks running; RHR 7-d ≥ baseline + 4 bpm; HRV 7-d ≤ baseline − 10 %; sleep 7-d ≤ baseline − 45 min;
comparable-group RPE ↑ ≥ 1; e1RM of the three main lifts flat/↓ for 3 weeks at maintained volume; fun ≤ 4/10 over 2 weeks;
motivation 😫 ≥ 3 days/week; active pain ≥ 4. **Reactive** deload when ≥ 3 signals (or pain ≥ 6); **preventive** after 4
weeks at ≥ 85 % target achievement without one; event taper via `EVENT_TAPER`. Duration 6 days. Effects = target multipliers
(`DELOAD.multipliers`) + `DELOAD_ACTIVE`. Persisted by the service as a `training_blocks` row with `focus = recovery`,
`source = ENGINE`, `reason`, `rules_triggered`; the user can end it early. `fitnessSignal` = { e1RM trend 28 d, pace@HR trend,
latest tests }, `fatigueSignal` = number of signals — both shown, neither is a "score".

## 9. Confidence

`score = min(data, readiness, todayWod, estimationShare, margin)`; `data` = analysed sessions in 28 d (≥ 8 → 1, ≥ 4 → 0.7, else 0.4);
`readiness` = measured+declared 1, declared only 0.75, none 0.4; `todayWod` = confirmed/≥ 0.7 → 1, blended 0.6, prior 0.4, no class 1;
`estimationShare` = 1 − fraction of residual coming from prior/template-only sessions; `margin` = clamp((score#1 − score#2) / 10, 0.5, 1).
HIGH ≥ 0.8, MEDIUM ≥ 0.55, else LOW; baseline phase caps at MEDIUM. LOW effects: hard candidates require intent or fixed status,
loads shown as ranges, three alternatives, `askFor` populated.

## 10. Weekly targets and macro-adjustment

`deriveWeeklyTargets` (domain/stimulus/targets.ts): spec §8 defaults per key window, block/goal/volume multipliers, floor 50 %,
post-condition Σ weekly hard exposures ≤ maxHard (tested). `reviewWeek` → `{ achieved, missing, excess, loadTrend, funAvg, flags,
deloadEvaluation, nextTargets }`; targets nudged ±10 % from flags; missed sessions are **not** carried over.

## 11. Layer B responsibilities and guardrails

| Task            | Input the model sees                                          | Output (Zod, strict)                 | Consumer                                       |
| --------------- | ------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------- |
| `parseWod`      | raw text/image + alias list                                   | `NormalizedWod` (structure only)     | `analyzeWod` (deterministic)                   |
| `parseIntent`   | one sentence + today/tomorrow dates                           | `UserIntent` (bounded enums/numbers) | engine (`intents`)                             |
| `explain`       | rulesTriggered + short numeric context                        | `{ text }` display-only              | UI; post-check rejects text naming absent kinds or loads; templated fallback |
| `suggestFun`    | allowed candidate kinds (engine-filtered) + preferences       | `{ options: NormalizedWod | CardioStep[] }[3]` | service analyses each and re-runs the engine; vetoed options dropped |
| `monthlyReview` | structured monthly summary                                    | `{ narrative }`                      | Monthly review screen                          |

AI tools are read-only over goals/targets/plan. `src/server/providers/ai` cannot import `@/db` (ESLint).

## 12. Test plan (spec §99 + review)

Golden scoring tests for §4, §33, §99-1..4; hard-budget lookahead ("class Saturday, 2 hard done Thursday → no VO2 today");
class tomorrow unknown → no heavy lower today; class tonight unknown + vo2 gap → VO2 not primary; parse confidence 0.4 → prior +
`wod_review`; Monday fresh + class tonight → no bonus; Thursday aerobic gap 2 with one free day → 30′ Z2 bonus; pain knee 6 → no
squat-heavy; pain 8 sudden → `MEDICAL_ADVICE`; baseline phase → ≤ 2 hard, no double; deload → no VO2; determinism; `checkPlacement`
"Heavy Legs the day before a squat class → warn"; `projectWeek` never proposes two hard days in a row.
