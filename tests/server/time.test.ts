import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { instantFor, localDate, localMinute, tzOffsetMinutes } from "@/server/time";

const PARIS = "Europe/Paris";
const NEW_YORK = "America/New_York";

/** Europe/Paris 2026: spring forward on 03-29 (02:00 CET → 03:00 CEST), fall back on 10-25 (03:00 CEST → 02:00 CET). */
describe("instantFor across DST transitions", () => {
  it("applies the offset in force at the target local time, not the one at UTC midnight", () => {
    // Spring-forward day: 18:00 is CEST (+02:00) → 16:00Z (the old code produced 17:00Z = 19:00 local).
    expect(instantFor("2026-03-29", 18 * 60, PARIS).toISOString()).toBe("2026-03-29T16:00:00.000Z");
    // Fall-back day: 18:00 is CET (+01:00) → 17:00Z (the old code produced 16:00Z = 17:00 local).
    expect(instantFor("2026-10-25", 18 * 60, PARIS).toISOString()).toBe("2026-10-25T17:00:00.000Z");
  });

  it("leaves ordinary days unchanged", () => {
    expect(instantFor("2026-03-28", 18 * 60, PARIS).toISOString()).toBe("2026-03-28T17:00:00.000Z");
    expect(instantFor("2026-03-30", 18 * 60, PARIS).toISOString()).toBe("2026-03-30T16:00:00.000Z");
    expect(instantFor("2026-09-28", 9 * 60 + 30, PARIS).toISOString()).toBe(
      "2026-09-28T07:30:00.000Z",
    );
    expect(instantFor("2026-09-28", 9 * 60 + 30, "Asia/Kolkata").toISOString()).toBe(
      "2026-09-28T04:00:00.000Z",
    );
  });

  it("round-trips through localDate/localMinute on both DST days and a normal day", () => {
    const days = ["2026-03-29", "2026-10-25", "2026-09-28"];
    const minutes = [0, 1, 59, 60, 119, 180, 181, 240, 11 * 60, 16 * 60, 18 * 60, 23 * 60 + 59];
    for (const date of days) {
      for (const minute of minutes) {
        const at = instantFor(date, minute, PARIS);
        expect(localDate(at, PARIS), `${date} ${minute}`).toBe(date);
        expect(localMinute(at, PARIS), `${date} ${minute}`).toBe(minute);
      }
    }
  });

  it("maps a non-existent spring-forward time to a real instant within the hour around it", () => {
    // 02:30 does not exist on 2026-03-29 in Paris: it resolves to 03:30 CEST (01:30Z).
    const at = instantFor("2026-03-29", 2 * 60 + 30, PARIS);
    expect(at.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(localDate(at, PARIS)).toBe("2026-03-29");
    expect(Math.abs(localMinute(at, PARIS) - (2 * 60 + 30))).toBeLessThanOrEqual(60);
  });

  it("maps an ambiguous fall-back time to an instant that reads back as that wall-clock time", () => {
    // 02:30 happens twice on 2026-10-25 in Paris (CEST then CET); the first reading is returned.
    const at = instantFor("2026-10-25", 2 * 60 + 30, PARIS);
    expect(at.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(localMinute(at, PARIS)).toBe(2 * 60 + 30);
  });

  it("works west of UTC (America/New_York 2026-03-08 and 2026-11-01)", () => {
    expect(instantFor("2026-03-08", 18 * 60, NEW_YORK).toISOString()).toBe(
      "2026-03-08T22:00:00.000Z",
    );
    expect(instantFor("2026-11-01", 18 * 60, NEW_YORK).toISOString()).toBe(
      "2026-11-01T23:00:00.000Z",
    );
    for (const date of ["2026-03-08", "2026-11-01"]) {
      const at = instantFor(date, 18 * 60, NEW_YORK);
      expect(localDate(at, NEW_YORK)).toBe(date);
      expect(localMinute(at, NEW_YORK)).toBe(18 * 60);
    }
  });

  it("works in the southern hemisphere (Australia/Sydney, DST in the local winter's opposite)", () => {
    const at = instantFor("2026-06-15", 8 * 60, "Australia/Sydney");
    expect(at.toISOString()).toBe("2026-06-14T22:00:00.000Z");
    expect(localDate(at, "Australia/Sydney")).toBe("2026-06-15");
    expect(localMinute(at, "Australia/Sydney")).toBe(8 * 60);
  });
});

describe("tzOffsetMinutes", () => {
  it("reads +60 / +120 around the Paris transitions", () => {
    expect(tzOffsetMinutes(new Date("2026-03-29T00:59:00Z"), PARIS)).toBe(60);
    expect(tzOffsetMinutes(new Date("2026-03-29T01:00:00Z"), PARIS)).toBe(120);
    expect(tzOffsetMinutes(new Date("2026-10-25T00:59:00Z"), PARIS)).toBe(120);
    expect(tzOffsetMinutes(new Date("2026-10-25T01:00:00Z"), PARIS)).toBe(60);
  });
});
