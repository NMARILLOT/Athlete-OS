import "server-only";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import { dailyReadiness, painLogs, userIntents } from "@/db/schema";
import type { IntensityBand, IntentKind, PainLocation } from "@/domain/core";
import type { IsoDate } from "@/domain/core/dates";
import { summarizeReadiness } from "@/domain/readiness";

/** Declared readiness (3 taps). Measured values arrive with Garmin in MVP 2. */
export async function declareReadiness(
  db: Db,
  userId: string,
  input: {
    date: IsoDate;
    energy: 1 | 2 | 3;
    soreness: 0 | 1 | 2 | 3;
    motivation: 1 | 2 | 3;
    unusualPain: boolean;
    note?: string;
  },
): Promise<void> {
  const summary = summarizeReadiness({
    declared: {
      energy: input.energy,
      soreness: input.soreness,
      motivation: input.motivation,
      unusualPain: input.unusualPain,
    },
    measured: null,
    computedAt: new Date().toISOString(),
  });
  await db
    .insert(dailyReadiness)
    .values({
      userId,
      date: input.date,
      energy: input.energy,
      soreness: input.soreness,
      motivation: input.motivation,
      unusualPain: input.unusualPain,
      note: input.note ?? "",
      declaredAt: new Date(),
      summary,
    })
    .onConflictDoUpdate({
      target: [dailyReadiness.userId, dailyReadiness.date],
      set: {
        energy: input.energy,
        soreness: input.soreness,
        motivation: input.motivation,
        unusualPain: input.unusualPain,
        note: input.note ?? "",
        declaredAt: new Date(),
        summary,
      },
    });
}

/** Declare today's wish; previous active day-scoped intents for that day are withdrawn. */
export async function declareIntent(
  db: Db,
  userId: string,
  input: {
    date: IsoDate;
    kind: IntentKind;
    intensity?: IntensityBand | null;
    availableMinutes?: number | null;
    rawText?: string | null;
    parsedBy?: "USER" | "AI_PARSED";
    confidence?: number | null;
    endsOn?: IsoDate | null;
  },
): Promise<void> {
  await db
    .update(userIntents)
    .set({ status: "withdrawn" })
    .where(
      and(
        eq(userIntents.userId, userId),
        eq(userIntents.status, "active"),
        eq(userIntents.startsOn, input.date),
      ),
    );
  await db.insert(userIntents).values({
    userId,
    startsOn: input.date,
    endsOn: input.endsOn ?? null,
    kind: input.kind,
    params: {
      intensity: input.intensity ?? undefined,
      availableMinutes: input.availableMinutes ?? undefined,
    },
    rawText: input.rawText ?? null,
    parsedBy: input.parsedBy ?? "USER",
    confidence: input.confidence ?? null,
    status: "active",
  });
}

/**
 * "Effacer" on Today: withdraw the active intents declared for `date`, plus any stale single-day
 * intent (ends_on null, starts_on before `date`) so a wish tapped on a previous day can never
 * linger in the engine input.
 */
export async function withdrawIntents(db: Db, userId: string, date: IsoDate): Promise<void> {
  await db
    .update(userIntents)
    .set({ status: "withdrawn" })
    .where(
      and(
        eq(userIntents.userId, userId),
        eq(userIntents.status, "active"),
        or(
          eq(userIntents.startsOn, date),
          and(isNull(userIntents.endsOn), lt(userIntents.startsOn, date)),
        ),
      ),
    );
}

/** Daily job: single-day intents from a past day expire (status `withdrawn`). Returns the count. */
export async function withdrawStaleIntents(
  db: Db,
  userId: string,
  today: IsoDate,
): Promise<number> {
  const rows = await db
    .update(userIntents)
    .set({ status: "withdrawn" })
    .where(
      and(
        eq(userIntents.userId, userId),
        eq(userIntents.status, "active"),
        isNull(userIntents.endsOn),
        lt(userIntents.startsOn, today),
      ),
    )
    .returning({ id: userIntents.id });
  return rows.length;
}

export async function logPain(
  db: Db,
  userId: string,
  input: {
    location: PainLocation;
    side?: "left" | "right" | "both" | null;
    intensity: number;
    movementSpecific: boolean;
    movements: string[];
    sudden: boolean;
    persistent: boolean;
    notes?: string;
  },
): Promise<{ id: string; medicalAdvice: boolean }> {
  const [row] = await db
    .insert(painLogs)
    .values({
      userId,
      location: input.location,
      side: input.side ?? null,
      intensity: input.intensity,
      movementSpecific: input.movementSpecific,
      movements: input.movements,
      sudden: input.sudden,
      persistent: input.persistent,
      notes: input.notes ?? "",
      status: "active",
    })
    .returning({ id: painLogs.id });
  if (!row) throw new Error("pain insert failed");
  return { id: row.id, medicalAdvice: input.intensity >= 7 || (input.sudden && input.persistent) };
}

export async function resolvePain(db: Db, userId: string, painId: string): Promise<void> {
  await db
    .update(painLogs)
    .set({ status: "resolved", resolvedAt: new Date() })
    .where(and(eq(painLogs.id, painId), eq(painLogs.userId, userId)));
}
