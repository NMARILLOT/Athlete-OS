import type { BuildExtraConfigColumns } from "drizzle-orm";
import {
  pgTable,
  timestamp,
  uuid,
  type PgColumnBuilderBase,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Table helpers (DATA_MODEL.md preamble, ARCHITECTURE.md §3/§7, ADR-019).
 *
 * This module only exports *function declarations*: it takes part in an import cycle with
 * `./users` (every user-owned table references `users.id`), and hoisted functions stay callable
 * while the cycle is being evaluated. The `users` reference itself is lazy (`references(() => …)`).
 */

/** `created_at` / `updated_at timestamptz not null default now()`; `updated_at` bumps on every update. */
export function timestampColumns() {
  return {
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  };
}

/**
 * Columns shared by every user-owned table: a client-generatable uuid primary key, the owner
 * (cascade on account deletion, ARCHITECTURE.md §7 "Privacy lifecycle") and the timestamps.
 */
export function ownedColumns() {
  return {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ...timestampColumns(),
  };
}
export type OwnedColumns = ReturnType<typeof ownedColumns>;

/**
 * Declare a user-owned table: adds `id`, `user_id`, `created_at`, `updated_at` and enables
 * row-level security with **no policies** (deny-all for the Supabase Data API; ownership is
 * enforced in code by `scoped(db, userId)`).
 */
export function userOwnedTable<
  TName extends string,
  TColumns extends Record<string, PgColumnBuilderBase>,
>(
  name: TName,
  columns: TColumns,
  extra?: (
    self: BuildExtraConfigColumns<TName, OwnedColumns & TColumns, "pg">,
  ) => PgTableExtraConfigValue[],
) {
  const merged: OwnedColumns & TColumns = { ...ownedColumns(), ...columns };
  return pgTable(name, merged, extra).enableRLS();
}
