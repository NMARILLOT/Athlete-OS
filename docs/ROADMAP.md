# Roadmap (spec §97–98)

## MVP 1 — foundations (this repository's first milestone)
- [x] Architecture, data model, engine design, ADRs, adversarial review
- [x] Domain: vocabulary, exercise catalog + resolver, strength math, load model, stimulus ledger/targets, athlete-model defaults, WOD schema/analyzer/parser
- [x] Domain: cardio (zones, builder, metrics, comparable groups), readiness summary
- [x] Engine: runEngine / projectWeek / checkPlacement, candidates, rules v1.0, scoring, confidence, golden tests
- [x] DB: Drizzle schema (RLS on every table), PGlite client, migrations, seed, integration tests
- [ ] Server: env, auth (supabase | local), scoped repo, services (workouts, strength sessions, inbox, recommendations, readiness, progress, profile, export/delete), providers (Garmin mock + official stub, AI anthropic + mock, body-comp manual, calendar null), FIT parser + import route, sync route, cron, health
- [ ] UI: Today, Calendar (week outlook + move check), Train (strength mode offline-first, cardio builder), WOD Inbox, Progress (4 dashboards + enjoyment), Profile, onboarding, "+" palette
- [ ] PWA: manifest, service worker precaching the strength shell, install hints

## MVP 2
Garmin official provider (Health / Activity / Training APIs, OAuth PKCE, webhooks), activity sync, workouts pushed to the watch,
measured readiness, advanced cardio analytics (pace@HR trends, decoupling, EF, threshold trend), Web Push (installed app only).

## MVP 3
Body composition provider (Withings/Garmin), advanced engine (learned athlete model, box priors, deload evaluation in the weekly review),
chat coach with server tools, weekly/monthly reviews with AI narrative, travel & events, advanced CrossFit analytics, calendar providers.
