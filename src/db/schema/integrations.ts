import {
  customType,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { userOwnedTable } from "./_helpers";
import { syncJobStatusEnum } from "./enums";
import { workouts } from "./workouts";

/**
 * Integrations & jobs (DATA_MODEL.md §10, ADR-020).
 */

/** `bytea` is not built into drizzle-orm's pg-core; AES-GCM envelopes are stored as raw bytes. */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return "bytea";
  },
});

/** `sync_jobs.payload` / `result` JSONB. */
export type SyncJobPayload = Record<string, string | number | boolean | null | string[]>;

/** `integrations` — one row per `(user_id, provider)`; tokens are an AES-256-GCM envelope. */
export const integrations = userOwnedTable(
  "integrations",
  {
    /** `garmin | withings | …` */
    provider: text("provider").notNull(),
    /** `disconnected | connected | error | revoked` */
    status: text("status").notNull().default("disconnected"),
    credentialsEncrypted: bytea("credentials_encrypted"),
    externalUserId: text("external_user_id"),
    scopes: text("scopes").array().notNull().default([]),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (t) => [uniqueIndex("integrations_user_provider_uq").on(t.userId, t.provider)],
);

/**
 * `sync_jobs` — idempotency + lease ledger processed synchronously by the daily cron or the
 * triggering request (`FOR UPDATE SKIP LOCKED` + `leased_until`).
 */
export const syncJobs = userOwnedTable(
  "sync_jobs",
  {
    /** `garmin_backfill | garmin_activity | fit_import | recompute | …` */
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    status: syncJobStatusEnum("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    payload: jsonb("payload").$type<SyncJobPayload>().notNull().default({}),
    result: jsonb("result").$type<SyncJobPayload>(),
    error: text("error"),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    leasedUntil: timestamp("leased_until", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("sync_jobs_user_kind_dedupe_uq").on(t.userId, t.kind, t.dedupeKey),
    index("sync_jobs_status_run_after_idx").on(t.status, t.runAfter),
  ],
);

/**
 * `client_events` — idempotency ledger for the strength outbox: `id` is the client event uuid
 * (ARCHITECTURE.md §4 "Strength session"); a replayed batch is a no-op.
 */
export const clientEvents = userOwnedTable(
  "client_events",
  {
    workoutId: uuid("workout_id")
      .notNull()
      .references(() => workouts.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    /** `session_started | set_completed | set_updated | set_deleted | exercise_added | exercise_swapped | session_finished` */
    type: text("type").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("client_events_workout_seq_idx").on(t.workoutId, t.seq)],
);
