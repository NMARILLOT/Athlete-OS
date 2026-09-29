import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { Encoder, Profile } from "@garmin/fitsdk";

const N = Profile.MesgNum as Record<string, number>;
type AnyMesg = Parameters<Encoder["onMesg"]>[1];
const asMesg = (m: Record<string, unknown>): AnyMesg => m as unknown as AnyMesg;
const FILE_ID = N.FILE_ID as number;
const RECORD = N.RECORD as number;
const LAP = N.LAP as number;
const SESSION = N.SESSION as number;
const ACTIVITY = N.ACTIVITY as number;
import { parseFit } from "@/server/fit/parser";

function buildRunFit(
  options: { withDynamics?: boolean; withHr?: boolean; sport?: string } = {},
): Uint8Array {
  const enc = new Encoder();
  const start = new Date("2026-09-29T07:15:00Z");
  enc.onMesg(
    FILE_ID,
    asMesg({
      type: "activity",
      manufacturer: "garmin",
      product: 4315,
      serialNumber: 3421009876,
      timeCreated: start,
    }),
  );
  for (let i = 0; i <= 600; i += 5) {
    const r: Record<string, unknown> = {
      timestamp: new Date(start.getTime() + i * 1000),
      distance: i * 3.1,
      speed: 3.1,
      cadence: 86,
      altitude: 120 + Math.sin(i / 100) * 5,
    };
    if (options.withHr !== false && i >= 10) r.heartRate = 140 + Math.round(5 * Math.sin(i / 60));
    if (options.withDynamics)
      Object.assign(r, { stanceTime: 245, verticalOscillation: 82, stepLength: 1150 });
    enc.onMesg(RECORD, asMesg(r));
  }
  const end = new Date(start.getTime() + 600_000);
  enc.onMesg(
    LAP,
    asMesg({
      timestamp: end,
      startTime: start,
      totalElapsedTime: 600,
      totalTimerTime: 600,
      totalDistance: 1860,
      avgHeartRate: 141,
      maxHeartRate: 148,
      avgSpeed: 3.1,
      avgCadence: 86,
    }),
  );
  const session: Record<string, unknown> = {
    timestamp: end,
    startTime: start,
    sport: options.sport ?? "running",
    subSport: "generic",
    totalElapsedTime: 600,
    totalTimerTime: 600,
    totalDistance: 1860,
    avgSpeed: 3.1,
    avgCadence: 86,
    totalAscent: 12,
    totalCalories: 110,
    avgTemperature: 14,
  };
  if (options.withHr !== false) Object.assign(session, { avgHeartRate: 141, maxHeartRate: 148 });
  if (options.withDynamics)
    Object.assign(session, {
      avgStanceTime: 245,
      avgVerticalOscillation: 82,
      avgStepLength: 1150,
      avgVerticalRatio: 7.1,
    });
  enc.onMesg(SESSION, asMesg(session));
  enc.onMesg(
    ACTIVITY,
    asMesg({
      timestamp: end,
      numSessions: 1,
      type: "manual",
      event: "activity",
      eventType: "stop",
    }),
  );
  return enc.close();
}

describe("FIT parser", () => {
  it("extracts session, laps and streams with running dynamics when present", () => {
    const parsed = parseFit(buildRunFit({ withDynamics: true }));
    const a = parsed.activity;
    expect(a.sport).toBe("running");
    expect(a.startTime).toBe("2026-09-29T07:15:00.000Z");
    expect(a.durationSec).toBe(600);
    expect(a.distanceM).toBe(1860);
    expect(a.avgHr).toBe(141);
    expect(a.avgCadence).toBe(172); // FIT running cadence is per foot → spm
    expect(a.streams.cadence?.[3]).toBe(172); // the stream is in the same unit as the summary
    expect(a.laps[0]?.avgCadence).toBe(172);
    expect(a.deviceSerial).toBe("3421009876");
    expect(a.laps).toHaveLength(1);
    expect(a.streams.sampleIntervalSec).toBe(5);
    expect(a.streams.hr).toBeDefined();
    expect(a.streams.hr?.[0]).toBeNull(); // first samples have no HR → null, never invented
    expect(a.streams.hr?.[3]).toBe(141);
    expect(a.streams.gctMs?.[3]).toBe(245);
    expect(a.streams.strideLengthM?.[3]).toBeCloseTo(1.15);
    expect(a.runningDynamics).toMatchObject({
      avgGctMs: 245,
      avgVerticalOscillationMm: 82,
      avgVerticalRatio: 7.1,
    });
    expect(a.runningDynamics?.avgStrideLengthM).toBeCloseTo(1.15);
    expect(parsed.sha256).toHaveLength(64);
    expect(a.externalId).toBe(parsed.sha256);
    expect(parsed.fileIdSerial).toBe("3421009876");
  });

  it("never invents absent metrics", () => {
    const parsed = parseFit(buildRunFit({ withDynamics: false, withHr: false }));
    const a = parsed.activity;
    expect(a.avgHr).toBeNull();
    expect(a.streams.hr).toBeUndefined();
    expect(a.streams.gctMs).toBeUndefined();
    expect(a.runningDynamics).toBeNull();
    expect(a.avgPowerW).toBeNull();
  });

  it("keeps cycling cadence as recorded (rpm is already the unit)", () => {
    const a = parseFit(buildRunFit({ sport: "cycling" })).activity;
    expect(a.avgCadence).toBe(86);
    expect(a.streams.cadence?.[3]).toBe(86);
    expect(a.laps[0]?.avgCadence).toBe(86);
  });

  it("rejects non-FIT bytes", () => {
    expect(() => parseFit(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]))).toThrow(
      /Not a FIT/,
    );
  });
});
