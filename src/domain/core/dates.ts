/**
 * Minimal date helpers on ISO strings. The domain never touches the system clock or
 * timezone database: the service layer converts to athlete-local ISO strings first.
 *
 * Conventions:
 *  - `IsoDate`     = "YYYY-MM-DD" (athlete-local calendar day)
 *  - `IsoDateTime` = full ISO 8601 string (with offset or Z)
 */

export type IsoDate = string;
export type IsoDateTime = string;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): value is IsoDate {
  return ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** Parse an IsoDate as a UTC midnight timestamp (day arithmetic only). */
function dayMs(date: IsoDate): number {
  if (!isIsoDate(date)) throw new Error(`Invalid IsoDate: ${date}`);
  return Date.parse(`${date}T00:00:00Z`);
}

function fromDayMs(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromDayMs(dayMs(date) + days * 86_400_000);
}

/** b - a in whole days (positive when b is after a). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((dayMs(b) - dayMs(a)) / 86_400_000);
}

/** Hours between two ISO datetimes (b - a). */
export function hoursBetween(a: IsoDateTime, b: IsoDateTime): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) throw new Error(`Invalid IsoDateTime: ${a} / ${b}`);
  return (tb - ta) / 3_600_000;
}

/** Calendar date part of an ISO datetime **as written** (no timezone conversion). */
export function dateOf(dateTime: IsoDateTime): IsoDate {
  const d = dateTime.slice(0, 10);
  if (!isIsoDate(d)) throw new Error(`Invalid IsoDateTime: ${dateTime}`);
  return d;
}

/** 0 = Monday … 6 = Sunday. */
export function isoWeekday(date: IsoDate): number {
  const jsDay = new Date(dayMs(date)).getUTCDay(); // 0 = Sunday
  return (jsDay + 6) % 7;
}

/** Monday of the ISO week containing `date`. */
export function isoWeekStart(date: IsoDate): IsoDate {
  return addDays(date, -isoWeekday(date));
}

/** Sunday of the ISO week containing `date`. */
export function isoWeekEnd(date: IsoDate): IsoDate {
  return addDays(isoWeekStart(date), 6);
}

/** Days remaining in the ISO week including `date` (Monday → 7, Sunday → 1). */
export function remainingDaysInWeek(date: IsoDate): number {
  return 7 - isoWeekday(date);
}

export function isSameWeek(a: IsoDate, b: IsoDate): boolean {
  return isoWeekStart(a) === isoWeekStart(b);
}

export function compareIsoDate(a: IsoDate, b: IsoDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minutesToClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function clockToMinutes(clock: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(clock);
  if (!m) throw new Error(`Invalid clock: ${clock}`);
  return Number(m[1]) * 60 + Number(m[2]);
}
