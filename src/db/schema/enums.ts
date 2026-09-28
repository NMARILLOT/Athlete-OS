import { pgEnum } from "drizzle-orm/pg-core";
import { CONFIDENCE_VALUES } from "../../domain/core/types";
import {
  WORKOUT_SOURCE_VALUES,
  WORKOUT_STATUS_VALUES,
  WORKOUT_TYPE_VALUES,
} from "../../domain/core/types";

/**
 * Postgres enums (DATA_MODEL.md preamble, ADR-013).
 *
 * Only *small state machines* are Postgres enums; evolving taxonomies (`stimulus_key`, `kind`,
 * `metric`, …) are `text` validated by Zod at the service boundary because drizzle-kit cannot rename
 * enum values safely. This module is a leaf (no schema imports) so it can be evaluated first.
 */

/** `workout_analyses.phase` (DATA_MODEL.md §3). */
export const ANALYSIS_PHASE_VALUES = ["planned", "actual"] as const;
export type AnalysisPhase = (typeof ANALYSIS_PHASE_VALUES)[number];

/** `wod_inbox_items.status` (DATA_MODEL.md §4). */
export const INBOX_STATUS_VALUES = [
  "new",
  "parsed",
  "needs_review",
  "confirmed",
  "discarded",
] as const;
export type InboxStatus = (typeof INBOX_STATUS_VALUES)[number];

/** `sync_jobs.status` (DATA_MODEL.md §10). */
export const SYNC_JOB_STATUS_VALUES = ["queued", "running", "done", "failed"] as const;
export type SyncJobStatus = (typeof SYNC_JOB_STATUS_VALUES)[number];

export const workoutTypeEnum = pgEnum("workout_type", WORKOUT_TYPE_VALUES);
export const workoutStatusEnum = pgEnum("workout_status", WORKOUT_STATUS_VALUES);
export const workoutSourceEnum = pgEnum("workout_source", WORKOUT_SOURCE_VALUES);
export const analysisPhaseEnum = pgEnum("analysis_phase", ANALYSIS_PHASE_VALUES);
export const inboxStatusEnum = pgEnum("inbox_status", INBOX_STATUS_VALUES);
export const syncJobStatusEnum = pgEnum("sync_job_status", SYNC_JOB_STATUS_VALUES);
export const confidenceEnum = pgEnum("confidence", CONFIDENCE_VALUES);
