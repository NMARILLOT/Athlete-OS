# Athlete OS — Architecture

> Companion documents: `SPEC.md` (product source of truth), `DATA_MODEL.md`, `ENGINE.md`, `DECISIONS.md` (ADRs), `ROADMAP.md`.

## 1. Product analysis in one paragraph

Athlete OS is a **single-athlete, long-lived decision system** disguised as a training app. The hard part is not the CRUD
(workouts, sets, activities) but the *adaptive planning engine* that fuses heterogeneous inputs (CrossFit box programming,
Garmin physiology, strength history, declared readiness and wishes) into one answer per day, with alternatives, an
explanation and a confidence level. Everything else (screens, sync, providers) exists to feed that engine with clean,
provenance-tagged data and to make acting on its output frictionless.

Three consequences drive the architecture:

1. **The domain layer is pure and testable.** All physiology math, WOD analysis, ledgers and rules live in
   `src/domain/**` with zero framework/DB imports (enforced by ESLint). Tests run in milliseconds without a database.
2. **Provenance is first-class.** Every stored datum carries `source` (`GARMIN | USER | AI_PARSED | CALCULATED | SCALE | MANUAL`),
   `confidence`, and calculated metrics carry `algorithmVersion`. Estimated values never masquerade as measured ones.
3. **AI is a translator, never an authority.** Layer B (LLM) produces schema-validated JSON (WOD structure, intent,
   explanations). Layer A (deterministic rules) is the only thing allowed to change the plan.

## 2. Stack (decided — see DECISIONS.md for rationale)

| Concern            | Choice                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------- |
| Framework          | Next.js 16 (App Router, React 19, Server Components + Server Actions), TypeScript strict |
| Styling            | Tailwind CSS 4, design tokens in `globals.css`, dark-first                               |
| Database           | PostgreSQL. Production: Supabase Postgres. Local dev & integration tests: embedded PGlite |
| ORM / migrations   | Drizzle ORM + drizzle-kit (SQL migrations committed in `drizzle/`)                       |
| Auth               | Supabase Auth (`@supabase/ssr`) in production; `AUTH_MODE=local` single user in dev only |
| Validation         | Zod 4 (AI outputs, server action inputs, JSONB columns)                                  |
| AI                 | Anthropic SDK (Layer B); `AI_PROVIDER=mock` fallback with a deterministic heuristic parser |
| Client state       | Zustand + IndexedDB (`idb-keyval`) for the in-session strength store and offline queue   |
| Charts             | Recharts                                                                                 |
| FIT parsing        | `@garmin/fitsdk` (official Garmin FIT SDK), server-side                                  |
| PWA                | `app/manifest.ts` + hand-written `public/sw.js` (app-shell cache, no Turbopack coupling) |
| Tests              | Vitest (domain unit tests; DB integration tests on PGlite)                               |
| Lint / format      | ESLint 9 flat config (`eslint-config-next` + typescript-eslint) + Prettier               |
| Hosting / jobs     | Vercel + Vercel Cron → `/api/cron/*` guarded by `CRON_SECRET`                             |
| Observability      | Structured JSON logger (`src/server/logging.ts`), no PII in logs                         |

## 3. Layered layout

```
src/
  domain/          PURE TypeScript. No React, no Next, no DB, no SDK. 100% unit-testable.
    core/          shared enums & types: MovementPattern, Modality, MuscleGroup, StimulusKey, LoadDimension,
                   DataSource, Confidence, dates helpers
    exercises/     exercise catalog (seed data) + alias resolver ("DL" → deadlift)
    stimulus/      stimulus taxonomy, credits, weekly targets, exposure ledger, exposure maps
    load/          session-RPE load, multi-dimensional load vector, residual fatigue decay, rolling stats
    strength/      e1RM (Epley v1), progression/autoload, rest timer policy, strength templates
    wod/           NormalizedWod zod schema, deterministic WodAnalyzer, heuristic text parser (fallback)
    cardio/        zones (versioned), cardio workout builder model, metrics (pace@HR, decoupling, EF),
                   comparable-group classifier
    readiness/     readiness snapshot summarisation against baselines
    athlete-model/ personal baselines, learned parameters (half-lives, per-exercise cost multipliers)
    engine/        Layer A: EngineInput → Recommendation (candidates, rules, scoring, explanation, confidence, trace)
  db/              Drizzle schema (one file per aggregate), client factory (postgres.js | PGlite), migrator, seed
  server/          application services (use-cases), providers, auth, jobs, logging
    auth/          getCurrentUser() — Supabase or local mode
    providers/     garmin/ (GarminProvider, Mock, Official stub), ai/ (AiProvider, Anthropic, Mock),
                   bodycomp/ (BodyCompositionProvider, Manual), calendar/ (CalendarProvider, Null)
    services/      workouts, strength-sessions, wod-inbox, recommendations (assemble → engine → persist),
                   ledger, progress queries, activities (FIT import), readiness, profile, data export/delete
    jobs/          cron handlers (morning readiness sync, evening ledger, weekly review)
    fit/           FitParser (tolerant field extraction) + normalisation to Activity
  app/             Next.js routes (App Router). Server Components read via services; mutations via Server Actions.
  components/      UI: design system primitives (`ui/`), feature components (`today/`, `strength/`, `inbox/`, ...)
  stores/          client stores (active strength session, offline mutation queue)
  lib/             framework-agnostic helpers usable on both client and server (formatting, ids, dates)
```

Dependency direction (enforced by ESLint `no-restricted-imports` on `src/domain/**`):

```
app → components → (stores) → server/services → domain
                              server/services → db
                              server/providers → domain (types only)
```

`domain` never imports upward. `db` never imports `server`. Providers return domain/normalised types, never raw vendor
payloads (raw payloads are persisted verbatim in `raw_payloads` for reprocessing).

## 4. Runtime shape

### Reads (fast path)
Server Components call services directly (`getTodayView(userId)`) and render. The Today recommendation is **read from
the `recommendations` table** (computed by a job or lazily on first request of the day), never recomputed on every render.

### Writes
Server Actions (`"use server"`) validate input with Zod, call a service, revalidate the path. Services are plain async
functions taking `{ db, userId, now }` so they are testable on PGlite.

### In-session strength mode (offline-first)
The active session lives in a Zustand store persisted to IndexedDB. Every completed set is appended to an
**outbox** (`{ id, type, payload, createdAt }`). A background flusher posts the outbox to a server action with
idempotency keys; the server upserts by client-generated set id. If the network is down, nothing changes for the user.

### Background work
`/api/cron/morning` (readiness/health sync + today's recommendation), `/api/cron/evening` (ledger, PR detection,
missing-RPE nudges), `/api/cron/weekly` (weekly review). Each handler enqueues `sync_jobs` rows and processes them
idempotently (unique `(user_id, kind, dedupe_key)`).

### Recompute triggers
Any write that changes training state (completed workout, WOD analysed, readiness answered, intent declared, pain
logged, calendar move) calls `recommendationService.recompute(userId, date)` — cheap because the engine is pure and the
context assembly is a handful of indexed queries over the last 28 days.

## 5. Data classification (what is measured vs declared vs estimated vs decided)

| Class                 | Examples                                                                                   | `source`                        | Storage                                              |
| --------------------- | ------------------------------------------------------------------------------------------ | ------------------------------- | ---------------------------------------------------- |
| **Measured**          | Garmin activities, HR/pace/power streams, laps, sleep, RHR, HRV, Body Battery, scale readings, set timestamps | `GARMIN`, `SCALE`, `DEVICE`     | `activities`, `activity_*`, `recovery_metrics`, `body_compositions` + `raw_payloads` |
| **Declared**          | RPE, fun score, readiness answers, pain, wishes/intents, WOD text, coach sessions, goals, availability, PR entered by hand | `USER`, `MANUAL`                | `workouts.rpe/fun_score`, `daily_readiness`, `pain_logs`, `user_intents`, `wod_inbox_items`, `goals`… |
| **Estimated**         | e1RM, HR zones from HRR, pace@HR, decoupling, EF, WOD stimulus credits, load vectors, AI-parsed WOD structure, comparable groups | `CALCULATED` (+`algorithm_version`), `AI_PARSED` (+`confidence`) | `computed_metrics`, `wod_analyses`, `workout_stimuli`, `personal_records` (flagged `estimated`) |
| **Engine decisions**  | Today recommendation, bonus, alternatives, deload flag, calendar-move warnings, weekly targets | `ENGINE`                        | `recommendations` (inputs snapshot, rules_triggered, output, explanation, confidence, engine_version) |
| **AI decisions**      | Parsed WOD candidate, parsed intent, explanation wording, "surprise me" candidates, monthly narrative | `AI`                            | `ai_invocations` (prompt hash, model, schema version, validated output). Never written to plan tables directly. |

Rules: an AI output becomes usable only after (1) Zod schema validation, (2) Layer A validation/scoring. UI labels
estimated values with a subtle "≈" marker and never shows a fake precision (e1RM rounded to 2.5 kg, trends over points).

## 6. External APIs & dependencies (and who must approve what)

| Integration                         | Status for MVP 1 | Needs                                                                                     |
| ----------------------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| Anthropic API (WOD parser, coach)   | Optional (mock fallback) | `ANTHROPIC_API_KEY` (user)                                                        |
| Supabase (Postgres + Auth + Storage)| Optional locally (PGlite + local auth) | Supabase project; on Vercel use pooled connection string           |
| Vercel (+ Cron)                     | Deployment       | Vercel project; Hobby plan allows daily crons only → morning/evening/weekly fit            |
| **Garmin Developer Program**        | Mocked           | **External approval required.** Apply for Health API + Activity API + Training API. OAuth 2.0 (PKCE). Push notifications require a public HTTPS callback. Endpoints are NOT invented here: implement `GarminOfficialProvider` against the official docs once credentials exist. |
| Garmin FIT SDK (`@garmin/fitsdk`)   | Used             | none (npm)                                                                                |
| Withings / other scale API          | Manual provider only | OAuth app registration on the vendor's developer portal once the scale brand is known |
| Google Calendar API                 | Null provider    | Google Cloud OAuth consent screen (later)                                                 |
| Apple Calendar                      | Not planned MVP  | No public third-party API; CalDAV with app-specific password or iOS Shortcuts webhook later |
| Box programming platform (SugarWOD/Wodify/BTWB) | Not planned | Most have no public API; WOD Inbox (paste/photo) is the stable path             |

## 7. Security & privacy

- All secrets server-only; no `NEXT_PUBLIC_` for anything sensitive.
- Garmin/Withings tokens stored in `integrations.credentials_encrypted` (AES-GCM with `INTEGRATION_ENCRYPTION_KEY`), never in logs.
- Row-level ownership: every user-owned table has `user_id`; services always filter on the authenticated user id.
  (Supabase RLS policies are added when Supabase is provisioned; Drizzle access goes through the service role on the server.)
- Data export (`/profile/data` → JSON zip) and deletion (cascade) are first-class services.
- Logger redacts known PII keys; no raw physiological streams in logs.

## 8. Feature flags

`src/server/flags.ts` reads `FLAG_*` env vars into a typed object. Flags: `garmin`, `aiCoach`, `bodyComp`,
`advancedReadiness`, `experimentalMetrics`. UI hides entry points; services throw `FeatureDisabledError` when called.

## 9. What is deliberately NOT built yet

- Multi-tenant concerns (billing, orgs). Single athlete, single timezone per profile.
- Real-time collaboration, push notifications infra (Web Push added in MVP 2 with the morning job).
- Garmin official provider, Withings, Google Calendar (interfaces + mocks exist; implementations gated by flags).
- Drag & drop calendar (MVP 1 uses explicit "move to day" with engine check; DnD is a UI upgrade, not a data change).
