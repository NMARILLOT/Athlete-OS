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
