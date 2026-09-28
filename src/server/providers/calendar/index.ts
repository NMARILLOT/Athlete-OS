import "server-only";
import type { IsoDate } from "@/domain/core/dates";
import type { TimeWindow } from "@/domain/core";

/**
 * CalendarProvider (spec §54): returns AVAILABILITY WINDOWS only — never event titles or attendees,
 * so private calendar content is never exposed to the engine or the AI.
 */
export interface AvailabilityDay {
  date: IsoDate;
  busy: TimeWindow[];
  /** Free windows derived from busy blocks within the athlete's day bounds. */
  available: TimeWindow[];
}

export interface CalendarProvider {
  readonly name: "null" | "google" | "caldav";
  getAvailability(
    userId: string,
    range: { from: IsoDate; to: IsoDate },
  ): Promise<AvailabilityDay[]>;
}

/** Null provider: no external calendar; availability comes from user-declared windows only. */
export class NullCalendarProvider implements CalendarProvider {
  readonly name = "null" as const;
  async getAvailability(): Promise<AvailabilityDay[]> {
    return [];
  }
}

/** Free windows from busy blocks inside [dayStart, dayEnd] minutes (pure helper, testable). */
export function freeWindows(busy: TimeWindow[], dayStart = 6 * 60, dayEnd = 22 * 60): TimeWindow[] {
  const sorted = [...busy]
    .filter((b) => b.endMinute > b.startMinute)
    .sort((a, b) => a.startMinute - b.startMinute);
  const out: TimeWindow[] = [];
  let cursor = dayStart;
  for (const b of sorted) {
    if (b.startMinute > cursor)
      out.push({ startMinute: cursor, endMinute: Math.min(b.startMinute, dayEnd) });
    cursor = Math.max(cursor, b.endMinute);
    if (cursor >= dayEnd) break;
  }
  if (cursor < dayEnd) out.push({ startMinute: cursor, endMinute: dayEnd });
  return out.filter((w) => w.endMinute - w.startMinute >= 15);
}

let instance: CalendarProvider | null = null;
export function calendarProvider(): CalendarProvider {
  if (instance) return instance;
  instance = new NullCalendarProvider();
  return instance;
}
