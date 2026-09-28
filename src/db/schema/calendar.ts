import { boolean, date, index, integer, text, uniqueIndex } from "drizzle-orm/pg-core";
import { userOwnedTable } from "./_helpers";

/**
 * Calendar, availability, events (DATA_MODEL.md §9).
 */

/** `availability_windows` — recurring (`weekday`) or dated (`date`) windows, athlete-local minutes. */
export const availabilityWindows = userOwnedTable(
  "availability_windows",
  {
    /** 0 = Monday … 6 = Sunday (ISO). */
    weekday: integer("weekday"),
    date: date("date"),
    startMinute: integer("start_minute").notNull(),
    endMinute: integer("end_minute").notNull(),
    /** `available | busy` */
    kind: text("kind").notNull().default("available"),
    /** `USER | CALENDAR_PROVIDER` */
    source: text("source").notNull().default("USER"),
    externalId: text("external_id"),
    /** Never a private calendar title. */
    label: text("label"),
  },
  (t) => [
    uniqueIndex("availability_windows_user_source_external_uq").on(
      t.userId,
      t.source,
      t.externalId,
    ),
    index("availability_windows_user_date_idx").on(t.userId, t.date),
    index("availability_windows_user_weekday_idx").on(t.userId, t.weekday),
  ],
);

/** `events` — races, competitions, tests with a taper. */
export const events = userOwnedTable(
  "events",
  {
    /** `race_5k | hyrox | open | custom | …` */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    date: date("date").notNull(),
    /** `A | B | C` */
    priority: text("priority").notNull().default("B"),
    taperDays: integer("taper_days").notNull().default(0),
    notes: text("notes").notNull().default(""),
  },
  (t) => [index("events_user_date_idx").on(t.userId, t.date)],
);

/** `travel_periods` — equipment and facility constraints while away. */
export const travelPeriods = userOwnedTable(
  "travel_periods",
  {
    destination: text("destination").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    /** IANA timezone at destination (MVP 3). */
    timezone: text("timezone"),
    equipment: text("equipment").array().notNull().default([]),
    crossfitAccess: boolean("crossfit_access").notNull().default(false),
    gymAccess: boolean("gym_access").notNull().default(false),
    runningOk: boolean("running_ok").notNull().default(true),
    bikeOk: boolean("bike_ok").notNull().default(false),
    notes: text("notes").notNull().default(""),
  },
  (t) => [index("travel_periods_user_starts_idx").on(t.userId, t.startsOn)],
);
