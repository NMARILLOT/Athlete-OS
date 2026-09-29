# Architecture Decision Records

Short, dated, reversible-by-default. Newest last.

## ADR-001 — Single Next.js app, layered by folder, not a monorepo
**Context.** One athlete, one deploy target (Vercel). A monorepo adds tooling cost without a second consumer.
**Decision.** One package. Boundaries enforced by folder + ESLint import restrictions (`src/domain` is framework-free).
**Consequence.** Extracting `domain` into a package later is a mechanical move.

## ADR-002 — Drizzle ORM over Prisma / Supabase-generated types
**Context.** Need type-safe SQL, committed migrations, and the ability to run the same schema on an embedded Postgres for tests.
**Decision.** Drizzle + drizzle-kit. Drivers: `postgres` (postgres.js) in production, `@electric-sql/pglite` locally and in tests.
**Consequence.** No Docker needed for dev; integration tests spin a fresh PGlite in ~200 ms. Supabase is "just Postgres".

## ADR-003 — Supabase Auth in production, `AUTH_MODE=local` in development
**Context.** Personal app; auth must exist but must not block local development or CI.
**Decision.** `getCurrentUser()` abstraction. `local` mode is refused when `NODE_ENV === "production"`.
**Consequence.** Every service takes `userId`; nothing in the domain knows about sessions.

## ADR-004 — AI is Layer B and only emits schema-validated JSON
**Context.** Spec §5/§6: AI must never write into the plan without rule validation.
**Decision.** `AiProvider` has typed methods (`parseWod`, `parseIntent`, `explain`, `suggestFun`) each returning a Zod-validated
object. Outputs are persisted in `ai_invocations` and consumed by services that run Layer A before touching plan tables.
**Consequence.** A deterministic heuristic WOD parser ships as the mock provider so the product works without an API key.

## ADR-005 — Exposure ledger in "exposure units", residual fatigue by exponential decay
**Context.** Spec §7, §46: reason in stimuli, not sessions; distinguish cardiovascular / muscular / impact / eccentric / technical fatigue.
**Decision.** Each workout yields `stimulusCredits: Record<StimulusKey, number>` (1.0 = one standard exposure) and a
`loadVector: Record<LoadDimension, 0..10>`. The engine computes residual fatigue per dimension as
`Σ load × 0.5^(hoursSince / halfLife[dim])` with athlete-specific half-lives (defaults in `athlete-model`).
**Consequence.** Rules threshold on continuous fatigue instead of brittle "did X in last 48 h" flags; still explainable
(`HIGH_LOWER_BODY_FATIGUE` with the number).

## ADR-006 — Engine output is a ranked candidate list, persisted with a full trace
**Context.** Spec §37, §62, §63, §100.
**Decision.** `runEngine(input): Recommendation` — pure, deterministic, versioned (`ENGINE_VERSION`). The trace stores
fatigue vector, ledger gaps, every candidate's score breakdown and every triggered rule.
**Consequence.** "POURQUOI ?" is rendered from the trace; regressions are testable as golden inputs.

## ADR-007 — Epley e1RM, version-pinned
**Context.** Spec §11.
**Decision.** `e1rm_epley_v1`: `w × (1 + reps/30)`, `null` for reps > 12 or reps < 1, rounded to 0.5 kg. Any change ships as `_v2` and recomputes history explicitly.

## ADR-008 — Hand-written service worker instead of a PWA plugin
**Context.** Next 16 builds with Turbopack; PWA plugins couple to webpack.
**Decision.** `public/sw.js` (app-shell precache + network-first for pages, cache-first for static assets) + `app/manifest.ts`.
**Consequence.** Offline strength mode relies on the IndexedDB store, not on the SW caching API responses.

## ADR-009 — Versioned HR zones, versioned metrics
**Context.** Spec §16, §69.
**Decision.** `hr_zone_sets` rows are immutable with `valid_from`; activities reference the zone set id used at analysis time.
`computed_metrics` rows carry `algorithm_version`; recomputation inserts new rows and marks old ones `superseded`.

## ADR-010 — Raw vendor payloads are kept
**Context.** Spec §68.
**Decision.** `raw_payloads` (provider, kind, external_id, payload JSONB or storage path, parser_version, imported_at).
FIT binaries go to Supabase Storage (or local `.data/` in dev); the parsed summary lands in `activities`.

## ADR-011 — Garmin is an interface first
**Context.** Spec §14, §72.
**Decision.** `GarminProvider` interface in `src/server/providers/garmin/types.ts`. `GarminMockProvider` produces realistic
activities/health data from seed fixtures. `GarminOfficialProvider` is a stub that throws `NotConfiguredError` until
`GARMIN_PROVIDER=official` and credentials exist — endpoints are implemented from the official docs, not invented.

## ADR-012 — No composite fitness score
**Context.** Spec §19.
**Decision.** Four transparent dashboards. Any composite is a documented, toggleable computed metric with a visible formula.

## ADR-013 — Planned vs actual analyses, no denormalised credit table
**Context.** Review finding: three overlapping analysis stores and no planned/actual distinction.
**Decision.** One `workout_analyses` table keyed `(workout_id, phase ∈ {planned, actual})`. `wod_analyses` and `workout_stimuli` dropped;
the ledger sums `actual` rows (today's fixed session may fall back to `planned`). Evolving taxonomies are `text` + Zod, not Postgres enums.

## ADR-014 — Normalised engine scoring, metabolic hard budget
**Context.** Simulation showed rest/mobility always winning and VO2 never proposed with the v1 formula; classes ate the hard budget.
**Decision.** Every score term is bounded (coverage ≤ 15, interference ≤ 12, recovery term only for recovery candidates, fixed rule
scales). "Hard" is computed by `classifyIntensity` on the metabolic axis; heavy strength is governed by muscular residual and a
separate `heavyStrength7d ≤ 3`. `crossfit_conditioning` split into `crossfit_exposure` + `hi_conditioning`; low-frequency keys count
over 14 days; `deriveWeeklyTargets` enforces Σ hard ≤ maxHard.

## ADR-015 — Fixed class with unknown WOD uses a prior and reserves a hard slot
**Decision.** `crossfit_generic` is generated only when a fixed class exists without a gated-in analysis (static prior, later the learned
weekday prior). Analyses enter the engine only when confirmed or `parseConfidence ≥ 0.7` (0.5–0.7 blended, < 0.5 prior + `wod_review`).
`FIXED_CLASS_RESERVE` protects today/tomorrow.

## ADR-016 — Bonus sessions are gated on the bonus, capped weekly, never enabled by free time
**Decision.** See ENGINE.md §7. `have_time` only widens availability. Output always carries `bonus: { kind: 'none', reason }` when refused.

## ADR-017 — Engine answers the week and placement questions without persisting projections
**Decision.** `projectWeek` and `checkPlacement` are pure entry points; the outlook is stored inside the recommendation row, real
`workouts` rows are created only when the user pins a day or confirms a WOD. The engine never inserts workouts.

## ADR-018 — Strength session is client-authoritative while in progress
**Decision.** Client-generated ids, IndexedDB bundle, ordered event outbox to `POST /api/sync/strength`, `client_events` idempotency,
autoload/rest/e1RM computed client-side from the domain layer. See ARCHITECTURE §4.

## ADR-019 — Deny-all RLS on every table, least-privilege Drizzle role, `scoped()` repository
**Decision.** `.enableRLS()` with no policies on all tables (Data API deny-all); app queries run as an application role through Drizzle;
ownership enforced by `scoped(db, userId)`; service role only for `auth.admin.deleteUser`. Integration test asserts RLS on every table.

## ADR-020 — PGlite is dev/test only; one daily cron; inline recompute
**Decision.** `createDb()` throws without `DATABASE_URL` in production; postgres.js `{ prepare: false, max: 1 }` singleton on `globalThis`;
`DIRECT_DATABASE_URL` for migrations. `/api/cron/daily` is the only cron (Hobby limit 2). User-triggered recompute runs inline and is
awaited before revalidation; tails run in `after()`. `sync_jobs` is an idempotency + lease ledger processed synchronously.

## ADR-021 — Auth fails closed; email/password or OTP only; `requireUser()` everywhere
**Decision.** `AUTH_MODE` defaults to `supabase`; `local` only off-Vercel and off-production. Sign-ups disabled + `ALLOWED_EMAILS`.
`requireUser()` first line of every action/route handler. `src/proxy.ts` refreshes cookies. No magic links / OAuth in MVP 1 (iOS standalone storage silo).
`ALLOWED_EMAILS` is mandatory in production with `AUTH_MODE=supabase` (empty allow-list = boot refused). `?next=` is sanitised to a same-origin path (`safeNextPath`).

## ADR-022 — Layer B outputs are structure-only and budgeted
**Decision.** `NormalizedWod` is `.strict()` and carries no physiology; intents are bounded structs with fixed bonuses; `explain` is
display-only with a post-check; per-kind daily caps and 30 s timeouts; identical inputs reuse the stored valid output.
Implemented in `ai-invocations.service.ts`: reuse keyed by `(kind, prompt_version, model, input_hash)`, per-user per-kind cap over a rolling 24 h
window (`AI_DAILY_CAP_PARSE_WOD` 30, `AI_DAILY_CAP_PARSE_INTENT` 50); capped or failed calls degrade to the heuristic parsers.

## ADR-023 — Review-round invariants (intents, moves, provenance)
**Decision.** A single-day intent applies only on its `starts_on` day (ranged intents on `starts_on ≤ today ≤ ends_on`); the daily job
withdraws stale ones. A user-moved workout keeps status `auto_adjusted` and stays in the engine's planned set (`ENGINE_PLANNED_STATUSES`).
Engine reschedules are proposed on Today ("Replanification proposée") and applied only by the athlete. Logged rest days carry a zero load
vector. A WOD is `heavy_strength` only when its analysis says so. `realised_intensity` comes from measured HR zones when an activity is
linked (source `CALCULATED`) and is otherwise upgraded from the RPE via the versioned classifier, never downgraded. Declared LTHR zones and
declared PRs are `MEDIUM` confidence; mock Garmin data is `provider = garmin_mock` / source `MOCK` and refused in production unless
`FLAG_GARMIN_MOCK_IN_PROD` is set. `finished_at` for late feedback is the planned end of the session, not the feedback time.

