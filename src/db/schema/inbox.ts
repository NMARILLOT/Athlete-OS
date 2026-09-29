import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  real,
  text,
  time,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { NormalizedWod } from "../../domain/wod/schema";
import type { WodAnalysis } from "../../domain/wod/types";
import { userOwnedTable } from "./_helpers";
import { inboxStatusEnum } from "./enums";
import { workouts } from "./workouts";

/**
 * WOD Inbox & AI (DATA_MODEL.md §4, ARCHITECTURE.md §4 "WOD Inbox flow").
 */

/** `wod_inbox_items` — inserted at `new` with the raw text **before** any parse. */
export const wodInboxItems = userOwnedTable(
  "wod_inbox_items",
  {
    /** `paste | quick | photo | connector` */
    inputKind: text("input_kind").notNull(),
    rawText: text("raw_text"),
    imagePath: text("image_path"),
    /** sha256 of the normalised input; unique per user among open items. */
    contentHash: text("content_hash").notNull(),
    status: inboxStatusEnum("status").notNull().default("new"),
    normalizedWod: jsonb("normalized_wod").$type<NormalizedWod>(),
    /** `AI_PARSED | HEURISTIC | USER` — null until parsed. */
    parseSource: text("parse_source"),
    parseConfidence: real("parse_confidence"),
    analysis: jsonb("analysis").$type<WodAnalysis>(),
    analysisVersion: text("analysis_version"),
    lastError: text("last_error"),
    scheduledFor: date("scheduled_for"),
    startLocal: time("start_local"),
    workoutId: uuid("workout_id").references(() => workouts.id, { onDelete: "set null" }),
  },
  (t) => [
    uniqueIndex("wod_inbox_items_open_hash_uq")
      .on(t.userId, t.contentHash)
      .where(sql`${t.status} in ('new', 'parsed', 'needs_review')`),
    index("wod_inbox_items_user_status_idx").on(t.userId, t.status),
  ],
);

/**
 * `ai_invocations` — audit + cache of every Layer B call, keyed by prompt version and input hash.
 * Only *valid* rows are unique per key (the reusable cache); failed attempts insert freely so each
 * one counts toward the daily cap (ADR-022).
 */
export const aiInvocations = userOwnedTable(
  "ai_invocations",
  {
    /** `parse_wod | explain | chat | suggest_fun | …` */
    kind: text("kind").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    inputHash: text("input_hash").notNull(),
    output: jsonb("output").$type<unknown>(),
    /** True when the output passed its strict Zod schema. */
    valid: boolean("valid").notNull().default(false),
    error: text("error"),
    latencyMs: integer("latency_ms").notNull().default(0),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
  },
  (t) => [
    uniqueIndex("ai_invocations_cache_uq")
      .on(t.kind, t.promptVersion, t.model, t.inputHash)
      .where(sql`${t.valid} = true`),
  ],
);
