import "server-only";
import type { IsoDate, IsoDateTime } from "@/domain/core/dates";

/**
 * Athlete-local clock helpers. Day columns are computed at WRITE time from the athlete's timezone
 * (DATA_MODEL.md conventions); the engine receives `now` as an ISO string with the local offset.
 */
export function localDate(now: Date, timeZone: string): IsoDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Minutes since local midnight. */
export function localMinute(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/** Offset (minutes east of UTC) of a timezone at an instant. */
export function tzOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const v = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second"));
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** ISO datetime with the athlete's local offset, e.g. 2026-10-01T08:15:00+02:00. */
export function localIso(now: Date, timeZone: string): IsoDateTime {
  const off = tzOffsetMinutes(now, timeZone);
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const shifted = new Date(now.getTime() + off * 60000);
  return `${shifted.toISOString().slice(0, 19)}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/**
 * Instant for a local date + minute-of-day in a timezone.
 *
 * The offset is sampled at UTC midnight, then re-evaluated at the candidate instant so that on a DST
 * transition day the offset in force at the target local time is the one applied (18:00 on the
 * spring-forward / fall-back day reads back as 18:00). A non-existent local time (inside the
 * spring-forward gap) maps to a real instant within the hour around it; an ambiguous one
 * (repeated during fall-back) maps to one of its two readings, deterministically.
 */
export function instantFor(date: IsoDate, minuteOfDay: number, timeZone: string): Date {
  const midnightUtc = new Date(`${date}T00:00:00Z`).getTime();
  const offAtMidnight = tzOffsetMinutes(new Date(midnightUtc), timeZone);
  const first = midnightUtc - offAtMidnight * 60000 + minuteOfDay * 60000;
  const offAtFirst = tzOffsetMinutes(new Date(first), timeZone);
  if (offAtFirst === offAtMidnight) return new Date(first);
  // A transition lies between midnight and the target: re-apply with the offset in force there.
  const second = first - (offAtFirst - offAtMidnight) * 60000;
  const offAtSecond = tzOffsetMinutes(new Date(second), timeZone);
  // If the corrected instant is not under that offset either, the local time does not exist
  // (spring-forward gap): keep the first candidate.
  return new Date(offAtSecond === offAtFirst ? second : first);
}
