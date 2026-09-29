# Athlete OS — Architecture — v2

> Companion documents: `SPEC.md` (product source of truth), `DATA_MODEL.md`, `ENGINE.md`, `DECISIONS.md` (ADRs), `ROADMAP.md`.
> v2 integrates the verified findings of the adversarial architecture review (data model, engine, product/UX, security/ops).

## 1. Product analysis in one paragraph

Athlete OS is a **single-athlete, long-lived decision system** disguised as a training app. The hard part is not the CRUD
(workouts, sets, activities) but the _adaptive planning engine_ that fuses heterogeneous inputs (CrossFit box programming,
Garmin physiology, strength history, declared readiness and wishes) into one answer per day, with alternatives, an
explanation and a confidence level. Everything else (screens, sync, providers) exists to feed that engine with clean,
provenance-tagged data and to make acting on its output frictionless.

Three consequences drive the architecture:

1. **The domain layer is pure and testable.** All physiology math, WOD analysis, ledgers and rules live in
   `src/domain/**` with zero framework/DB imports (enforced by ESLint). Tests run in milliseconds without a database.
2. **Provenance is first-class.** Every stored datum carries `source` (`GARMIN | DEVICE | SCALE | USER | MANUAL | AI_PARSED | HEURISTIC | CALCULATED | ENGINE`),
   `confidence`, and calculated metrics carry `algorithmVersion`. Estimated values never masquerade as measured ones.
3. **AI is a translator, never an authority.** Layer B (LLM) produces schema-validated, structure-only JSON (WOD structure,
   intent, explanation wording). Layer A (deterministic rules) is the only thing allowed to change the plan.

## 2. Stack (decided — see DECISIONS.md)

| Concern          | Choice                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Framework        | Next.js 16 (App Router, React 19, Server Components + Server Actions + Route Handlers), TypeScript strict                |
| Styling          | Tailwind CSS 4, design tokens in `globals.css`, dark-first, 56 px tap targets                                            |
| Database         | PostgreSQL. Production: Supabase Postgres (**`DATABASE_URL` mandatory**). Dev & tests: embedded PGlite (never in prod)   |
| ORM / migrations | Drizzle ORM + drizzle-kit; SQL migrations committed in `drizzle/`, applied by the Vercel build hook (ADR-024)  |
| Auth             | Supabase Auth, **email + password / email OTP only** (no magic link, no OAuth in MVP 1); `AUTH_MODE=local` for localhost |
| Validation       | Zod 4 (AI outputs `.strict()`, server action inputs, JSONB columns, env)                                                 |
| AI               | Anthropic SDK (Layer B) with `maxRetries: 1`, `timeout: 30 s`, per-kind budgets; `AI_PROVIDER=mock` → heuristic parser   |
| Client state     | Zustand (`persist`, `skipHydration`) + IndexedDB via `idb-keyval` for the active strength session and its event outbox   |
| Charts           | Recharts                                                                                                                 |
| FIT parsing      | `@garmin/fitsdk`, server-side, in the upload request                                                                     |
| PWA              | `app/manifest.ts` + hand-written `public/sw.js` (shell precache incl. strength mode, network-first navigations)          |
| Tests            | Vitest (domain unit tests; DB integration tests on PGlite incl. an RLS assertion)                                        |
| Lint / format    | ESLint 9 flat config + typescript-eslint + import boundaries; Prettier                                                   |
| Hosting / jobs   | Vercel + **one** Vercel Cron (`/api/cron/daily`) — Hobby allows 2; the second slot is reserved for Garmin sync in MVP 2  |
| Observability    | Structured JSON logger with a closed `LogFields` type (no free-form objects, no health data), `/api/health`              |

## 3. Layered layout and import boundaries

```
src/
  domain/          PURE TypeScript, isomorphic. No React/Next/DB/SDK. 100 % unit-testable.
    core/          vocabulary (patterns, modalities, muscles, stimuli, load dims, intents, provenance), date helpers
    exercises/     catalog (97 entries, FR/EN aliases) + resolver
    stimulus/      goal→stimulus affinity, target derivation, rolling exposure ledger, heatmaps
    load/          session-RPE, residual fatigue, rolling load, intensity classifier, impact units, planned→actual scaling
    strength/      e1RM (Epley v1), autoload progression, rest policy, templates
    wod/           NormalizedWod (strict Zod), WodAnalyzer, heuristic parser
    cardio/        zones (versioned), workout builder model, metrics (pace@HR, decoupling, EF), comparable groups
    readiness/     readiness summary (declared + measured deviations → band)
    athlete-model/ defaults (single source of numeric priors), baselines, merged params
    engine/        Layer A: runEngine / projectWeek / checkPlacement, candidates, rules, scoring, explanation, confidence
  lib/             isomorphic helpers (ids, formatting, cn)
  stores/          client stores (active strength session + outbox). Import domain + lib + actions/api ONLY.
  components/      UI (design system primitives in ui/, feature components). Import domain types, lib, stores, actions ONLY.
  app/             routes. RSC pages import server/services; client islands import stores/components; actions.ts import server.
  server/          `import "server-only"`. auth/, env.ts, flags.ts, logging.ts, providers/, services/, jobs/, fit/, repo/
  db/              `import "server-only"`. Drizzle schema (helper `userOwnedTable` → user_id FK cascade + RLS), client, migrator, seed
```

Allowed edges (ESLint `no-restricted-imports`):

```
app(RSC/actions/api) → server/services → { domain, db, server/providers, server/repo }
app(client) / components / stores → { domain, lib, app/**/actions, /api/* }        (never @/server, never @/db)
server/providers/ai → domain only (never @/db)
domain → nothing above it
```

### Route map (MVP 1)

| Route                                                                  | Boundary                 | Notes                                                                                                          |
| ---------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `/today`                                                               | RSC + client islands     | one `getTodayView()` query; `AUTRE OPTION` cycles alternatives client-side                                     |
| `/calendar`                                                            | RSC + client island      | week outlook from `recommendations.output.weekOutlook` + real workouts; move → `checkPlacement`                |
| `/train`                                                               | RSC                      | Strength / Cardio / CrossFit / Free entry points                                                               |
| `/train/strength/[workoutId]`                                          | **client-only shell**    | hydrates from IndexedDB bundle; works cold offline (precached by SW)                                           |
| `/train/strength/new`, `/train/cardio/new`                             | RSC + island             | template picker / cardio builder                                                                               |
| `/inbox`, `/inbox/new`, `/inbox/[id]`                                  | RSC + island             | paste → parse → confirm (read-only structure + "Corriger le texte") → analyse → replan                         |
| `/log/{activity,coach,rest,pain,body}`                                 | RSC + form island        | "+" palette targets                                                                                            |
| `/progress`                                                            | RSC                      | four dashboards + enjoyment                                                                                    |
| `/profile`, `/profile/goals`, `/profile/data`, `/profile/integrations` | RSC + islands            | goals weights, increments, export/delete, flags                                                                |
| `/workouts/[id]`, `/exercises/[id]`, `/activities/[id]`                | RSC                      | detail pages with in-app back header                                                                           |
| `/onboarding/[step]`                                                   | RSC + island             | gated in `(app)/layout.tsx` by `users.onboarding_completed_at`; completion sets `baseline_phase_until = +21 d` |
| `/api/sync/strength`                                                   | Route Handler            | outbox event batches (stable URL across deploys)                                                               |
| `/api/import/fit`, `/api/inbox/photo`                                  | Route Handler, multipart | `export const maxDuration = 60`; parse in-request                                                              |
| `/api/cron/daily`, `/api/health`                                       | Route Handler            | cron secret (constant-time, fails closed); health = `select 1`                                                 |

Every non-tab route renders an in-app header with back/close (iOS standalone has no browser chrome).

## 4. Runtime shape

### Today (reads are instant)

`getTodayView(userId)` returns `{ recommendation, plannedWorkouts, activeSessionHint, readinessDeclared, insight }` from the
`recommendations` row computed by the cron. If the row is missing, `ensureTodayRecommendation()` is an **idempotent upsert
fallback** (never the normal path). Intent buttons call a server action that awaits the inline `recompute()` and returns the
new `Recommendation`, rendered immediately (`useOptimistic` for the label); `revalidatePath` only for consistency.
`AUTRE OPTION` cycles `Recommendation.alternatives` client-side and persists `accepted_option` fire-and-forget.
Declared readiness (3 taps) is an inline Today chip in MVP 1; measured readiness arrives with Garmin in MVP 2.

### Recompute

`recommendationService.recompute(userId, date)`: assemble `EngineInput` (indexed queries over 28 days), `runEngine`,
`projectWeek`, persist one versioned row in a transaction under `pg_advisory_xact_lock(hashtext(userId))`. Triggered inline by
every training-state write (completed workout, WOD confirmed, readiness, intent, pain, calendar move) and by the cron. The
non-blocking tail (PR detection, ledger rollups, computed metrics) runs in Next's `after()`.

### Strength session (offline-first) — the contract

1. **Bundle.** `strengthSessionService.getBundle(workoutId)` → `{ workout, exercises[] (prescription incl. loadSuggestionKg,
lastExposure, bestE1rm, incrementKg), restPolicy }`. Today prefetches today's bundle into IndexedDB via a small client island;
   `/train/strength/[workoutId]` is a client-only shell that hydrates from IndexedDB (`persist` with `skipHydration: true`,
   explicit `rehydrate()`, a `hydrating` state) — never an RSC that needs the server. Ad-hoc sessions get client uuids.
2. **Source of truth.** While `workouts.status = in_progress` the client store is authoritative; the server is a write-behind
   replica. Resume = IndexedDB first, server replica only when IndexedDB is empty. Today shows "Reprendre la séance" when a
   session is in progress.
3. **Client-side intelligence.** Autoload (`decideProgression`), rest policy and e1RM are domain functions imported by the
   store — they work offline. Rest timer stores `restEndsAt` (epoch ms) and derives the countdown; re-syncs on
   `visibilitychange`; requests `navigator.wakeLock`; an `AudioContext` is unlocked on the DONE tap so the chime plays;
   no haptics on iOS web.
4. **Outbox = ordered event log** `{ id: uuid, workoutId, seq, type: session_started | set_completed | set_updated | set_deleted |
exercise_added | exercise_swapped | session_finished, payload, at }`, posted in batches to `POST /api/sync/strength`, applied in
   one transaction, idempotent via `client_events (id)`; acknowledged ids are pruned client-side. All ids client-generated
   (`workouts`, `workout_exercises`, `strength_sets`). Flush on `online`, `visibilitychange`, after each event when online, on app open.
5. **Finish.** `session_finished` carries RPE / feeling / pain; the server computes e1RM, PRs, `workout_analyses.actual`, then `recompute`.
6. Logout is a client flow (`SignOutButton`): rehydrate → flush the outbox → refuse while it is non-empty → post `LOGOUT` to the service worker → clear the IndexedDB session → server sign-out. On 401/403 the client keeps IndexedDB, re-authenticates, then flushes. The outbox is also flushed by the root-mounted `RegisterServiceWorker` on app open, every route change, `online` and `visibilitychange`, so a session finished offline reaches the server without reopening the shell; `navigator.storage.persist()` is requested on first run.
7. The server never revives a closed workout: `session_started` on a `done` or `skipped` row is acknowledged and ignored, and so is `session_finished` unless the row was closed by the daily sweep (rpe and feeling null), in which case the athlete's own late finish re-runs the analysis, load and PRs with every set. A finish with no working set and no RPE sends the row back to `planned`. The sweep keys on inactivity (start_at / last set older than a day), not on the plan date alone. The shell shows "Séance terminée" instead of re-seeding, the server status wins over a local unfinished session, and the persisted session/outbox is bound to its owner (`ownerUserId`) and never posted or shown under another account. Skipping a live strength/cardio session is refused; it ends with a finish.

### WOD Inbox flow (spec §49)

`Today[JE VAIS AU CROSSFIT]` records intent `going_crossfit` → `/inbox/new?for=DATE` (textarea, paste, quick chips) →
`createInboxItem` **saves raw text first** (status `new`, `content_hash`) → `parseInboxItem` (AI if `AI_PROVIDER=anthropic`, else
heuristic; AI failure → heuristic, status `needs_review` when confidence < 0.7) with a visible "Analyse…" state → `/inbox/[id]`
read-only structure + "C'est ça / Corriger le texte" → `confirmInboxItem({ date, startLocal })` (default from
`preferred_training_times.crossfit`) creates the **fixed** crossfit workout, materialises `workout_exercises`, writes
`workout_analyses.planned`, runs `recompute` inline → back to Today with "Parfait. Cette séance couvre…" + bonus/none.
After the class: score + RPE + feeling (< 10 s) → `workout_analyses.actual` → recompute.
The parser is selected by `AI_PROVIDER`; `FLAG_AI_COACH` gates chat / explain / suggestFun only.

### Background work

One cron `/api/cron/daily` (03:30 UTC): for each user, dispatch by `users.timezone` and weekday — morning tasks daily
(readiness/health sync placeholder, `recompute` today, week outlook), evening tasks folded into the next run (PR detection,
missing-RPE nudges, ledger), weekly review when the athlete-local weekday is Sunday. `sync_jobs` rows are claimed with
`FOR UPDATE SKIP LOCKED` + `lease_until`, re-queued with exponential backoff, failed after `max_attempts`; every enqueue site
also calls `after(() => runJobsOnce())` so imports never wait for the cron.

## 5. Data classification

| Class                | Examples                                                                                                      | `source`                                                       | Storage                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Measured**         | Garmin activities, HR/pace/power streams, laps, sleep, RHR, HRV, Body Battery, scale readings, set timestamps | `GARMIN`, `DEVICE`, `SCALE`                                    | `activities*`, `recovery_metrics`, `body_compositions`, `raw_payloads`                              |
| **Declared**         | RPE, feeling, readiness answers, pain, intents, WOD text, coach sessions, goals, availability, manual PRs     | `USER`, `MANUAL`                                               | `workouts.rpe/feeling`, `daily_readiness`, `pain_logs`, `user_intents`, `wod_inbox_items`, `goals`… |
| **Estimated**        | e1RM, HR zones from HRR, pace@HR, decoupling, EF, WOD credits/loads, intensity, comparable groups, parsed WOD | `CALCULATED` (+version), `AI_PARSED`/`HEURISTIC` (+confidence) | `computed_metrics`, `workout_analyses`, `wod_inbox_items.analysis`, `personal_records.estimated`    |
| **Engine decisions** | Recommendation, bonus, alternatives, reschedules, deload proposal, placement verdicts, weekly targets         | `ENGINE`                                                       | `recommendations`, `training_blocks(source=ENGINE)`, `weekly_stimulus_targets(source=ENGINE)`       |
| **AI decisions**     | Parsed WOD structure, parsed intent, explanation wording, fun suggestions, monthly narrative                  | `AI_PARSED`                                                    | `ai_invocations`; consumed only after Zod + Layer A                                                 |

UI marks estimated values with "≈" and never fakes precision (e1RM to 2.5 kg, trends over points, ranges when confidence is LOW).

## 6. External APIs and who must approve what

| Integration                          | MVP 1 status              | Needs                                                                                                                                                                               |
| ------------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic API                        | Optional (heuristic mock) | `ANTHROPIC_API_KEY` (user). Per-kind daily caps in `ai_invocations`; timeouts 30 s; no re-prompt loops                                                                              |
| Supabase (Postgres + Auth + Storage) | Optional locally          | Project; **disable sign-ups**; `ALLOWED_EMAILS`; pooled `DATABASE_URL` (6543, `prepare:false`) + `DIRECT_DATABASE_URL` (5432)                                                       |
| Vercel (+ Cron)                      | Deployment                | Hobby: 2 crons/day → `/api/cron/daily` only                                                                                                                                         |
| **Garmin Developer Program**         | Mocked                    | **External approval required** (Health + Activity + Training APIs). OAuth 2.0 PKCE, public HTTPS callback. Endpoints implemented from the official docs only once credentials exist |
| Garmin FIT SDK                       | Used                      | none                                                                                                                                                                                |
| Withings / scale API                 | Manual provider           | Vendor developer registration once the scale brand is known                                                                                                                         |
| Google Calendar API                  | Null provider             | Google Cloud OAuth consent screen (MVP 3)                                                                                                                                           |
| Apple Calendar                       | Not planned               | No public API; CalDAV app password or Shortcuts webhook later                                                                                                                       |
| Box programming platforms            | Not planned               | Paste/photo is the stable path                                                                                                                                                      |

## 7. Security, privacy, runtime constraints

**Control model.** supabase-js is used for **Auth only**. All data access is Drizzle through a least-privilege role in
`DATABASE_URL`; ownership is enforced in code by `scoped(db, userId)` (every user-owned query goes through it; a test greps
for raw `db.select().from(userOwned)` outside `src/server/repo`). Every table calls `.enableRLS()` with **no policies** →
deny-all for the public Data API even though the anon key ships in the client. A PGlite integration test asserts
`relrowsecurity = true` for every table. `SUPABASE_SERVICE_ROLE_KEY` is imported only by `src/server/auth/admin.ts`.

**Auth boundary.** `src/server/env.ts` (Zod, `server-only`): `AUTH_MODE` defaults to `supabase`; `local` is allowed only when
`NODE_ENV !== "production" && !process.env.VERCEL`, else boot fails. `requireUser()` is the first line of every server action
and route handler; services never trust a caller-supplied user id. `getCurrentUser()` upserts the `users` row lazily.
`src/proxy.ts` refreshes the Supabase cookie and redirects unauthenticated page navigations (matcher excludes `/_next`, An authenticated account outside `ALLOWED_EMAILS` is signed out by the proxy and sent to `/login?reason=forbidden` (page navigations only; Route Handlers keep answering 403); `signOutAction` is the one Server Action without `requireUser()` since it only ends the caller's own session, so the error boundaries can offer it.
`/icons`, `/sw.js`, `/manifest.webmanifest`, `/offline`, `/api/cron/*`, `/api/health`). Sign-ups disabled in Supabase +
`ALLOWED_EMAILS` allowlist as defence in depth. Cron secret compared in constant time and **fails closed** when unset.

**Secrets & tokens.** All secrets server-only; `src/server/**` and `src/db/**` start with `import "server-only"`.
Integration tokens (MVP 2): AES-256-GCM envelope `version || nonce || ciphertext || tag`, AAD `${userId}:${provider}`,
`INTEGRATION_ENCRYPTION_KEY` (+ `_PREV` for rotation), `token_expires_at` + `refresh_lock_until` on `integrations`; errors sanitised.

**Privacy lifecycle.** `user_id` FKs cascade. Storage keys `users/{userId}/{kind}/{sha256}.{ext}` in private buckets so deletion is
a prefix delete. `deleteAccount`: revoke integrations → delete storage prefix → `DELETE FROM users` → `auth.admin.deleteUser`
→ one audit line with the id only. `exportAccount` → JSON zip of every user-owned table + raw payload references. The service
worker caches navigations per device only; logout posts `LOGOUT` (page cache cleared) after the outbox is flushed.
Logger fields are a closed type (`userId`, ids, counts, durations, rule ids, error codes) — health values cannot be logged.

**iOS standalone / Next 16.** Email+password or email OTP typed in-app (magic links open in Safari's separate storage silo);
`navigator.storage.persist()` on first run; `wakeLock` on session screens; every non-tab route has an in-app back;
uploads go through multipart Route Handlers (Server Actions cap at 1 MB and serialise per client); Web Push is MVP 2 and
installed-app only.

## 8. Feature flags

`src/server/flags.ts` reads `FLAG_*` env vars into a typed object: `garmin`, `aiCoach`, `bodyComp`, `advancedReadiness`,
`experimentalMetrics`. UI hides entry points; services throw `FeatureDisabledError`. The WOD parser is not flag-gated: it is
selected by `AI_PROVIDER` and always has the heuristic fallback.

## 9. Deliberately not built yet

Multi-tenant concerns; real-time collaboration; Web Push; Garmin official provider, Withings, Google Calendar (interfaces +
mocks exist); drag-and-drop calendar (MVP 1 uses "move to day" with `checkPlacement`); per-travel timezone (MVP 3).
