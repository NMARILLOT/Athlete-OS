# Athlete OS — Adaptive engine (Layer A) and AI (Layer B)

## 0. Contract

```ts
runEngine(input: EngineInput): Recommendation   // pure, deterministic, versioned (ENGINE_VERSION = "1.x")
```

The engine never reads the database or the clock; the service layer assembles `EngineInput` and passes `now`.
Everything it decides is reproducible from the persisted `inputs_snapshot`.

## 1. Inputs

```ts
interface EngineInput {
  now: string;                       // ISO datetime in athlete tz
  today: string;                     // YYYY-MM-DD (athlete tz)
  profile: {
    goalWeights: Record<GoalKey, number>;         // health_longevity, crossfit, endurance, strength, physique, fun + specific goals
    weeklyTargets: Record<StimulusKey, number>;   // derived from goals + block + athlete model (§4)
    baselinePhase: boolean;                       // first weeks → conservative
    maxHardSessionsPerWeek: number;               // default 3 (spec §8)
    weeklyHoursTarget: number;                    // current progressive target (e.g. 7 → 12 over months)
    preferences: { favouriteModalities; dislikedModalities; increments };
    equipmentAvailable: Equipment[];              // from profile / travel mode
  };
  history: HistorySession[];        // completed sessions, last 28 days, each with credits/loadVector/exposures/intensity/rpe/fun
  planned: PlannedSession[];        // today..+7, status planned, `fixed` flag (class time, coaching), optional wodAnalysis
  crossfitToday?: WodAnalysis;      // when the WOD is known
  readiness?: ReadinessSnapshot;    // declared + measured + baselines comparison (see domain/readiness)
  pain: ActivePain[];
  intent?: UserIntent;              // today's declared wish (want_run, going_crossfit, feel_hot, lazy, have_time, rest, surprise, custom)
  availability?: { windows: TimeWindow[]; totalMinutes: number };
  athleteModel: AthleteModelParams; // half-lives, exercise cost multipliers, tolerance (defaults if unlearned)
  deloadState?: { active: boolean; reason?: string; until?: string };
}
```

## 2. Derived state (computed first, all explainable)

| Derived quantity            | How                                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `residualFatigue[dim]`      | `Σ_sessions load[dim] × 0.5^(hoursSince / halfLife[dim])`, dims: cardiovascular, muscular_lower, muscular_upper, impact, eccentric, technical         |
| `patternExposure72h[p]`     | weighted sum of pattern exposure over 72 h (weights 1.0 / 0.6 / 0.3 by day)                                                                          |
| `hardSessions7d`            | count of `intensity = hard` sessions in trailing 7 days, CrossFit metcons included                                                                   |
| `ledger` (ISO week)         | `credits[k] = Σ credits` for the week (Mon→today); `gap[k] = max(0, target[k] − credits[k])`; `excess[k]`                                             |
| `remainingDays`             | days left in the ISO week including today                                                                                                            |
| `weeklyLoad7d`, `load28dAvg`| session-RPE loads; `loadRatio` = 7d / (28d/4) — displayed, never used alone to veto                                                                   |
| `readinessBand`             | `good | ok | poor` from declared (energy, soreness, motivation) + measured deviations from baselines (RHR ↑, HRV ↓, sleep ↓) — requires ≥ 2 signals to be `poor` |
| `impactBudget`              | `Σ impact load 7d` vs athlete tolerance                                                                                                              |
| `tomorrowDemand`            | load vector expected from tomorrow's fixed/planned session (e.g. class WOD with heavy squats)                                                        |

## 3. Candidate generation

Candidates come from a code catalog (`domain/engine/candidates.ts`) plus context-specific ones:

- Strength: `strength_lower`, `strength_upper`, `strength_full`, `accessory_upper`, `olympic_technique`, `gymnastics_skill`
- Endurance easy: `run_easy_45`, `run_easy_60`, `run_long_90`, `bike_easy_60`, `bike_long_120`, `row_easy_30`, `ski_easy_30`, `walk_45`
- Endurance hard: `run_threshold`, `run_vo2`, `run_tempo`, `bike_intervals`, `row_intervals`, `strides`
- CrossFit: `crossfit_as_programmed` (only if `crossfitToday`/planned fixed WOD known — credits from the analysis), `crossfit_generic` (unknown WOD: median box-class assumptions, lower confidence), `partner_wod_fun`, `benchmark_attempt`
- Recovery: `mobility_20`, `recovery_spin_30`, `rest`
- Intent-specific: from `intent.kind` (e.g. `want_run` adds run variants at 3 intensities; `have_time` enables double-session evaluation)

Each candidate declares `expectedCredits`, `loadVector`, `durationMin`, `intensity`, `modality`, `patterns`, `equipment`,
`impact`, `timeOfDay?`.

## 4. Rules (Layer A)

A rule is `{ id, kind: 'safety' | 'balance' | 'preference', evaluate(ctx, candidate?) → RuleOutcome | null }` where
`RuleOutcome = { effect: 'veto' | 'penalty' | 'bonus' | 'note', score?: number, message: string, data?: object }`.
Safety rules can veto; balance/preference rules only shift scores. All fired rules are recorded.

Initial rule set (ids are stable API for tests and explanations):

| id                                   | kind       | Logic (summary)                                                                                                         |
| ------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| `HIGH_LOWER_BODY_FATIGUE`            | safety     | residual muscular_lower ≥ threshold → veto candidates with lower-body muscular load ≥ 6; penalty above 3                 |
| `HIGH_UPPER_BODY_FATIGUE`            | safety     | same for upper                                                                                                          |
| `HIGH_IMPACT_LOAD`                   | safety     | impact residual or 7-day impact budget exceeded → veto high-impact hard candidates, penalise running                     |
| `HIGH_CARDIO_FATIGUE`                | safety     | cardiovascular residual high → veto hard cardio & hard metcons                                                          |
| `HARD_SESSION_BUDGET_EXCEEDED`       | safety     | hardSessions7d ≥ max → veto any `hard` candidate (fixed CrossFit class is exempt but flagged → bonus becomes none)       |
| `PATTERN_REPEAT_72H`                 | balance    | same dominant pattern (squat/hinge/push/pull) heavily loaded within 72 h → penalty                                        |
| `TOMORROW_HEAVY_CONFLICT`            | balance    | tomorrow's fixed session loads the same muscles heavily → penalty on today's heavy candidate for that region             |
| `CROSSFIT_COVERS_STIMULUS`           | balance    | today's WOD already credits a stimulus ≥ 0.8 → penalty on candidates duplicating it; note explains coverage             |
| `READINESS_POOR`                     | safety     | readinessBand poor (≥ 2 signals) → veto hard; penalty moderate; note. Never vetoes on a single noisy metric               |
| `PAIN_ACTIVE`                        | safety     | active pain ≥ 4 → veto candidates involving flagged movements/patterns; ≥ 7 or sudden+persistent → `MEDICAL_ADVICE` note  |
| `WEEKLY_GAP_PRIORITY`                | balance    | bonus ∝ gap coverage weighted by goal weights (the core "fill the holes" logic)                                          |
| `PROTECT_EASY_VOLUME`                | balance    | if hard cardio share this week > 25 % of cardio minutes → penalty on hard cardio (polarisation)                         |
| `AEROBIC_BASE_BELOW_TARGET`          | balance    | `gap[aerobic_easy]` large and remainingDays low → bonus on easy aerobic                                                  |
| `LONG_SESSION_PLACEMENT`             | balance    | long aerobic candidate only on days with ≥ 90 min availability and no hard session yesterday                            |
| `DELOAD_ACTIVE`                      | safety     | deload → veto hard strength/VO2; cap durations; note                                                                     |
| `BASELINE_PHASE_CONSERVATIVE`        | safety     | baselinePhase → hard-session max reduced to 2; no double sessions                                                        |
| `INTENT_RESPECT`                     | preference | bonus to candidates matching the declared intent; if all matching candidates are vetoed → pick the nearest safe variant and explain (`INTENT_DECLINED_WITH_ALTERNATIVE`) |
| `VARIETY`                            | preference | same candidate kind 3 days running → penalty; favourite modalities small bonus; disliked penalty                          |
| `DOUBLE_SESSION_VALUE`               | balance    | second session allowed only if primary is easy/moderate, ≥ 4 h gap, total daily load under cap, and a gap ≥ 0.8 exists   |
| `AVAILABILITY_FIT`                   | safety     | candidate duration > largest window → veto (or shrink to a shorter variant)                                             |
| `TEST_OPPORTUNITY`                   | balance    | fresh + no test in 6 weeks + goal needs it → bonus on a test candidate (never more than one per 2 weeks)                 |
| `EVENT_TAPER`                        | safety     | event within `taper_days` → veto hard non-specific; bonus specific easy                                                  |

## 5. Scoring & selection

```
score(c) = Σ_k min(credit_c[k], gap[k]) × goalWeight(k) × 10        // gap coverage
         − Σ_dim loadVector_c[dim] × residualFatigue[dim] × 0.4      // interference
         + Σ bonus − Σ penalty                                         // rules
         + intentBonus (0..15) + varietyBonus (−3..+2)
```

1. Fixed session today (class, coaching) → it is the primary unless a safety veto fires; if vetoed, the fixed session
   stays (the user will go) but the engine attaches a `SCALE_ADVICE` note ("garde la classe, allège les squats") and no bonus.
2. Otherwise primary = best non-vetoed candidate. If the best candidate is `rest`/`mobility`, the primary is a recovery
   proposal ("Rien aujourd'hui. Récupère.").
3. Bonus = best candidate passing `DOUBLE_SESSION_VALUE`, else none.
4. Alternatives = next 2–3 non-vetoed candidates of *different kinds* than the primary.
5. Explanation = template over the top 2–3 fired rules + the top gap, ≤ 2 sentences, French.
6. Confidence: `HIGH` when history ≥ 14 days and readiness present and (no CrossFit today or WOD confidence ≥ 0.7);
   `MEDIUM` when exactly one of those is missing; `LOW` otherwise or during baseline phase.

## 6. Intent handling (spec §32–33)

`intent.kind` maps to a candidate filter + bonus; **it never bypasses safety rules**. When every intent-matching candidate
is vetoed, the engine emits `INTENT_DECLINED_WITH_ALTERNATIVE` and promotes the closest safe variant (same modality,
lower intensity or shorter), producing the spec's "Mauvaise idée aujourd'hui… on garde l'esprit Hyrox" behaviour.

## 7. Weekly targets derivation

`deriveWeeklyTargets({ goalWeights, block, weeklyHoursTarget, athleteModel })` starts from the spec §8 defaults
(strength_lower 2, strength_upper 2, hypertrophy 1, olympic_technique 1, gymnastics_skill 1, aerobic_easy 3,
aerobic_long 1, threshold 1, vo2max 0.5, power 0.5, crossfit_conditioning 3, mobility_recovery 2), scales by block focus
(never below 50 % of default for any key — "a dominant never erases other capacities") and by weekly hours target.

## 8. Weekly macro-adjustment (v1 minimal)

`reviewWeek(history, targets, readiness, pain, fun)` → `{ achieved, missing, excess, loadTrend, funAvg, flags }` and
`nextWeekTargets` = targets nudged ±10 % based on flags (fatigue signals → −10 %, all green and fun ≥ 7 → +5 % volume).
Missed sessions are **not** carried over.

## 9. Layer B (AI) responsibilities and guardrails

| Task            | Input the model sees                                                            | Output schema         | Consumer                                  |
| --------------- | ------------------------------------------------------------------------------- | --------------------- | ----------------------------------------- |
| `parseWod`      | raw text (or image) + exercise alias list                                       | `NormalizedWod`       | `WodAnalyzer` (deterministic)             |
| `parseIntent`   | one user sentence + today/tomorrow dates                                        | `UserIntent`          | engine (as `intent`)                      |
| `explain`       | rulesTriggered + short numeric context (never the whole DB)                     | `{ text }`            | UI (templated fallback always available)  |
| `suggestFun`    | allowed candidate kinds (already engine-filtered) + preferences                 | `{ options[3] }`      | "SURPRISE ME" — each option re-scored by engine |
| `monthlyReview` | structured monthly summary                                                       | `{ narrative }`       | Monthly review screen                     |

The model never receives raw calendar titles, tokens, or unrelated history. Every output is Zod-validated; on failure the
service falls back to the heuristic parser / templates and records the failure in `ai_invocations`.

## 10. Test plan (spec §99 mapped)

- Yesterday heavy squat + wall balls; today CrossFit with front squats → no heavy leg accessory in primary/bonus/alternatives; `CROSSFIT_COVERS_STIMULUS` + `HIGH_LOWER_BODY_FATIGUE` fired.
- Two easy days, readiness good, `vo2max` gap → a VO2 candidate may be primary.
- Intent `want_run`, impact residual low → primary is a run; planned strength moved (flag `RESCHEDULE_SUGGESTED`).
- Intent `want_run hard`, impact high + readiness poor → primary is an easy/non-impact alternative; `INTENT_DECLINED_WITH_ALTERNATIVE`.
- Hyrox case (§33) → decline with alternative.
- Hard-session budget reached → no hard candidate proposed; fixed class still primary with `SCALE_ADVICE`.
- Deload active → no hard strength/VO2.
- Pain knee 6 → no squat-heavy candidates; pain 8 sudden → `MEDICAL_ADVICE` note.
- Baseline phase → max 2 hard, no double.
- Golden trace snapshot: same input → identical output (determinism).
