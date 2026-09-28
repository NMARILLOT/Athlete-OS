import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  hoursBetween,
  isoWeekStart,
  isoWeekday,
  remainingDaysInWeek,
  isIsoDate,
  dateOf,
  clockToMinutes,
  minutesToClock,
} from "./dates";

describe("dates", () => {
  it("adds days across month boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("computes day differences", () => {
    expect(daysBetween("2026-09-01", "2026-09-28")).toBe(27);
    expect(daysBetween("2026-09-28", "2026-09-01")).toBe(-27);
  });

  it("computes hours between datetimes", () => {
    expect(hoursBetween("2026-09-27T18:30:00Z", "2026-09-28T08:00:00Z")).toBeCloseTo(13.5);
  });

  it("finds ISO week start (Monday)", () => {
    // 2026-09-28 is a Monday
    expect(isoWeekday("2026-09-28")).toBe(0);
    expect(isoWeekStart("2026-09-28")).toBe("2026-09-28");
    expect(isoWeekStart("2026-10-04")).toBe("2026-09-28"); // Sunday
    expect(remainingDaysInWeek("2026-09-28")).toBe(7);
    expect(remainingDaysInWeek("2026-10-04")).toBe(1);
  });

  it("validates ISO dates", () => {
    expect(isIsoDate("2026-02-30")).toBe(true); // Date.parse is lenient; we only validate shape here
    expect(isIsoDate("2026-2-3")).toBe(false);
    expect(dateOf("2026-09-28T18:30:00+02:00")).toBe("2026-09-28");
  });

  it("converts clocks", () => {
    expect(clockToMinutes("18:30")).toBe(1110);
    expect(minutesToClock(1110)).toBe("18:30");
  });
});
