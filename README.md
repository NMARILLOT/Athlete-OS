# Athlete OS

Personal, adaptive hybrid-training operating system: CrossFit, strength, endurance and recovery fused into one daily
answer — *voici ce que tu fais aujourd'hui* — with alternatives, an explanation and a confidence level.

- Product spec: [`docs/SPEC.md`](docs/SPEC.md) (source of truth)
- Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · Data model: [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) · Engine: [`docs/ENGINE.md`](docs/ENGINE.md) · Decisions: [`docs/DECISIONS.md`](docs/DECISIONS.md) · Roadmap: [`docs/ROADMAP.md`](docs/ROADMAP.md)

## Stack

Next.js 16 (App Router, React 19) · TypeScript strict · Tailwind 4 · Drizzle + PostgreSQL (Supabase in production, embedded
PGlite in dev/tests) · Supabase Auth · Zod · Anthropic SDK (Layer B, optional) · `@garmin/fitsdk` · Vitest · PWA.

## Run locally

```bash
cp .env.example .env.local        # defaults: AUTH_MODE=local, AI_PROVIDER=mock, GARMIN_PROVIDER=mock, PGlite database
npm install
npm run db:migrate                # applies drizzle/ migrations to ./.pglite (no DATABASE_URL needed locally)
npm run db:seed                   # exercise catalog, benchmarks, templates
npm run dev
```

Open http://localhost:3000. In local mode there is a single user and no login.

## Checks

```bash
npm run typecheck && npm run lint && npm run test && npm run build   # or: npm run check
```

## Layout

```
src/domain/     pure TypeScript: vocabulary, exercises, stimulus ledger, load model, strength math, WOD schema/analyzer/parser,
                cardio (zones, builder, metrics), readiness, athlete model, and the adaptive engine (Layer A)
src/db/         Drizzle schema (RLS on every table), client (postgres.js | PGlite), migrations, seed, scoped repository
src/server/     env (fails closed), auth, providers (Garmin mock/official stub, AI anthropic/mock, body-comp, calendar),
                FIT parser, services, jobs
src/app/        routes (Today, Calendar, Train, Progress, Profile, Inbox, API)
src/components/ UI primitives and feature components · src/stores/ offline-first strength session store
```

## Production

Set `DATABASE_URL` (Supabase pooler, port 6543), `DIRECT_DATABASE_URL` (5432, migrations only), `AUTH_MODE=supabase`,
Supabase URL/anon key, `ALLOWED_EMAILS`, `CRON_SECRET`. Disable sign-ups in the Supabase project. Run `npm run db:migrate`
against `DIRECT_DATABASE_URL` before promoting a deploy. One Vercel Cron: `/api/cron/daily`.

Garmin's official APIs require Developer Program approval; until then `GARMIN_PROVIDER=mock` and manual FIT import.
