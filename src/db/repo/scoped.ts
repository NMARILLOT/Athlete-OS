import { and, eq, type InferInsertModel, type SQL } from "drizzle-orm";
import type { AnyPgColumn, PgInsertValue, PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Db } from "../client";

/**
 * Ownership-scoped repository (ARCHITECTURE.md §7, ADR-019).
 *
 * Every query over a user-owned table goes through `scoped(db, userId)`: reads, updates and
 * deletes always carry `user_id = $userId`, inserts always force it. Services never trust a
 * caller-supplied user id — `requireUser()` provides it.
 */

/** A table declared with `userOwnedTable()` (has a `user_id uuid not null` column). */
export type UserOwned = PgTable & { userId: AnyPgColumn<{ data: string }> };

/** Insert values without the owner (it is forced by the repository). */
export type InsertValues<T extends UserOwned> = Omit<InferInsertModel<T>, "userId">;

/** Update values without the owner (a row can never change hands). */
export type UpdateValues<T extends UserOwned> = Omit<PgUpdateSetSource<T>, "userId">;

function ownerFilter<T extends UserOwned>(table: T, userId: string, where?: SQL): SQL {
  const owner = eq(table.userId, userId);
  return where ? (and(owner, where) as SQL) : owner;
}

function selectOwned<T extends UserOwned>(db: Db, table: T, userId: string, where?: SQL) {
  // `from()` guards against empty data-modifying subqueries with a conditional type that TS
  // cannot resolve for a generic table; a `UserOwned` table is never a subquery, so the guard
  // is bypassed here and the concrete table type is kept through the explicit type argument.
  return db
    .select()
    .from<T>(table as never)
    .where(ownerFilter(table, userId, where));
}

function insertOwned<T extends UserOwned>(
  db: Db,
  table: T,
  userId: string,
  values: InsertValues<T> | InsertValues<T>[],
) {
  const rows = (Array.isArray(values) ? values : [values]).map((row) => ({ ...row, userId }));
  return db.insert(table).values(rows as PgInsertValue<T>[]);
}

function updateOwned<T extends UserOwned>(
  db: Db,
  table: T,
  userId: string,
  values: UpdateValues<T>,
  where?: SQL,
) {
  return db
    .update(table)
    .set({ ...values, userId } as PgUpdateSetSource<T>)
    .where(ownerFilter(table, userId, where));
}

function deleteOwned<T extends UserOwned>(db: Db, table: T, userId: string, where?: SQL) {
  return db.delete(table).where(ownerFilter(table, userId, where));
}

export interface ScopedDb {
  readonly userId: string;
  /** `SELECT * FROM table WHERE user_id = $userId [AND where]` — chain `orderBy`/`limit` as usual. */
  select<T extends UserOwned>(table: T, where?: SQL): ReturnType<typeof selectOwned<T>>;
  /** Insert one or many rows with `user_id` forced to the scope's user. */
  insert<T extends UserOwned>(
    table: T,
    values: InsertValues<T> | InsertValues<T>[],
  ): ReturnType<typeof insertOwned<T>>;
  /** Update rows of this user only; `user_id` cannot be changed. */
  update<T extends UserOwned>(
    table: T,
    values: UpdateValues<T>,
    where?: SQL,
  ): ReturnType<typeof updateOwned<T>>;
  /** Delete rows of this user only. */
  delete<T extends UserOwned>(table: T, where?: SQL): ReturnType<typeof deleteOwned<T>>;
  /** Run `fn` inside a transaction with a scope bound to the transaction. */
  withTx<R>(fn: (tx: ScopedDb) => Promise<R>): Promise<R>;
}

/** Bind a database handle to one user. */
export function scoped(db: Db, userId: string): ScopedDb {
  return {
    userId,
    select: (table, where) => selectOwned(db, table, userId, where),
    insert: (table, values) => insertOwned(db, table, userId, values),
    update: (table, values, where) => updateOwned(db, table, userId, values, where),
    delete: (table, where) => deleteOwned(db, table, userId, where),
    withTx: (fn) => db.transaction((tx) => fn(scoped(tx, userId))),
  };
}
