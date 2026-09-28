import "server-only";
import { addDays, type IsoDate, type IsoDateTime } from "@/domain/core/dates";
import type { CardioWorkoutSpec } from "@/domain/cardio";
import type {
  GarminActivityDetails,
  GarminActivitySummary,
  GarminDailyHealth,
  GarminProvider,
  GarminWorkoutPushResult,
} from "./types";

/** Deterministic pseudo-random generator so fixtures are stable across runs (seeded by string). */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * GarminMockProvider — realistic fixtures for development (spec §14): a Forerunner-like device,
 * easy runs at ~5:30/km with HR ~145, one interval session per week, indoor bike, daily health data
 * with plausible RHR/HRV/sleep and occasional bad nights. Streams are generated at 1 Hz-equivalent
 * (5 s samples) and contain nulls in the first seconds like real recordings.
 */
export class GarminMockProvider implements GarminProvider {
  readonly name = "mock" as const;
  private pushed = new Map<string, GarminWorkoutPushResult>();

  async isConnected(): Promise<boolean> {
    return true;
  }

  async getActivities(
    _userId: string,
    range: { from: IsoDateTime; to: IsoDateTime },
  ): Promise<GarminActivitySummary[]> {
    const out: GarminActivitySummary[] = [];
    const from = range.from.slice(0, 10);
    const to = range.to.slice(0, 10);
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const a = this.activityFor(d);
      if (a) out.push(a);
    }
    return out;
  }

  async getActivity(_userId: string, externalId: string): Promise<GarminActivityDetails | null> {
    const date = externalId.replace("mock-", "").slice(0, 10);
    const summary = this.activityFor(date);
    if (!summary || summary.externalId !== externalId) return null;
    return this.details(summary);
  }

  async getHealthData(
    _userId: string,
    range: { from: IsoDate; to: IsoDate },
  ): Promise<GarminDailyHealth[]> {
    const out: GarminDailyHealth[] = [];
    for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
      const r = rng(`health-${d}`);
      const badNight = r() < 0.12;
      const sleepHours = badNight ? 5.2 + r() * 0.8 : 6.8 + r() * 1.4;
      out.push({
        date: d,
        sleepHours: Math.round(sleepHours * 10) / 10,
        sleepScore: Math.round(badNight ? 55 + r() * 15 : 72 + r() * 20),
        restingHr: Math.round(badNight ? 52 + r() * 5 : 46 + r() * 5),
        hrvRmssd: Math.round(badNight ? 38 + r() * 10 : 55 + r() * 20),
        stress: Math.round(badNight ? 35 + r() * 20 : 20 + r() * 15),
        bodyBattery: Math.round(badNight ? 35 + r() * 20 : 65 + r() * 30),
        respiration: Math.round((13 + r() * 3) * 10) / 10,
        vo2maxEst: 52,
        lthr: 172,
        raw: { source: "mock", date: d },
      });
    }
    return out;
  }

  async createWorkout(_userId: string, spec: CardioWorkoutSpec): Promise<GarminWorkoutPushResult> {
    const id = `mock-wk-${spec.kind}-${this.pushed.size + 1}`;
    const res: GarminWorkoutPushResult = {
      garminWorkoutId: id,
      scheduledFor: null,
      status: "synced",
      message: "Workout créé (mock)",
    };
    this.pushed.set(id, res);
    return res;
  }

  async scheduleWorkout(
    _userId: string,
    garminWorkoutId: string,
    date: IsoDate,
  ): Promise<GarminWorkoutPushResult> {
    const existing = this.pushed.get(garminWorkoutId);
    const res: GarminWorkoutPushResult = {
      garminWorkoutId,
      scheduledFor: date,
      status: existing ? "synced" : "failed",
      message: existing ? `Planifié le ${date} (mock)` : "Workout inconnu",
    };
    if (existing) this.pushed.set(garminWorkoutId, res);
    return res;
  }

  async disconnect(): Promise<void> {
    this.pushed.clear();
  }

  // ---------------------------------------------------------------------------

  private activityFor(date: IsoDate): GarminActivitySummary | null {
    const r = rng(`act-${date}`);
    const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = Monday
    // Tue: easy run, Thu: intervals, Sat: long run, Sun: indoor bike, others: nothing (CrossFit is logged in-app).
    let sport: string;
    let durationSec: number;
    let distanceM: number | null;
    let avgHr: number;
    let maxHr: number;
    let avgSpeedMps: number | null;
    let subSport: string | null = null;
    switch (weekday) {
      case 1:
        sport = "running";
        durationSec = Math.round(45 * 60 + r() * 300);
        avgSpeedMps = 1000 / (330 + r() * 20);
        distanceM = Math.round(durationSec * avgSpeedMps);
        avgHr = Math.round(143 + r() * 6);
        maxHr = avgHr + 12;
        break;
      case 3:
        sport = "running";
        subSport = "track";
        durationSec = Math.round(50 * 60 + r() * 240);
        avgSpeedMps = 1000 / (290 + r() * 15);
        distanceM = Math.round(durationSec * avgSpeedMps);
        avgHr = Math.round(158 + r() * 6);
        maxHr = 184;
        break;
      case 5:
        sport = "running";
        durationSec = Math.round(85 * 60 + r() * 600);
        avgSpeedMps = 1000 / (340 + r() * 20);
        distanceM = Math.round(durationSec * avgSpeedMps);
        avgHr = Math.round(146 + r() * 6);
        maxHr = avgHr + 14;
        break;
      case 6:
        sport = "cycling";
        subSport = "indoor_cycling";
        durationSec = Math.round(60 * 60 + r() * 300);
        avgSpeedMps = null;
        distanceM = null;
        avgHr = Math.round(132 + r() * 8);
        maxHr = avgHr + 15;
        break;
      default:
        return null;
    }
    const startTime = `${date}T${weekday === 5 || weekday === 6 ? "09" : "07"}:${String(Math.round(r() * 40) + 10).padStart(2, "0")}:00+02:00`;
    return {
      externalId: `mock-${date}-${sport}`,
      sport,
      subSport,
      startTime,
      utcOffsetSec: 7200,
      durationSec,
      distanceM,
      avgHr,
      maxHr,
      avgSpeedMps,
      avgPowerW: sport === "cycling" ? Math.round(180 + r() * 30) : null,
      avgCadence: sport === "running" ? Math.round(172 + r() * 6) : Math.round(85 + r() * 8),
      elevationGainM: sport === "running" ? Math.round(r() * 120) : 0,
      calories: Math.round((durationSec / 60) * (sport === "running" ? 11 : 9)),
      deviceName: "Forerunner 965",
      deviceSerial: "3421009876",
      raw: { source: "mock", date, sport },
    };
  }

  private details(summary: GarminActivitySummary): GarminActivityDetails {
    const r = rng(`det-${summary.externalId}`);
    const interval = 5;
    const n = Math.floor(summary.durationSec / interval);
    const hr: Array<number | null> = [];
    const speed: Array<number | null> = [];
    const cadence: Array<number | null> = [];
    const altitude: Array<number | null> = [];
    const dist: Array<number | null> = [];
    const gct: Array<number | null> = [];
    const vo: Array<number | null> = [];
    const stride: Array<number | null> = [];
    const isIntervals = summary.subSport === "track";
    let cum = 0;
    for (let i = 0; i < n; i++) {
      const t = i * interval;
      if (i < 3) {
        hr.push(null);
        speed.push(null);
        cadence.push(null);
        altitude.push(null);
        dist.push(null);
        gct.push(null);
        vo.push(null);
        stride.push(null);
        continue;
      }
      const warm = Math.min(1, t / 600);
      let hrV = (summary.avgHr ?? 140) - 15 * (1 - warm) + (r() - 0.5) * 4;
      let spd = summary.avgSpeedMps ?? 0;
      if (isIntervals) {
        const phase =
          t > 600 && t < summary.durationSec - 600 ? Math.floor((t - 600) / 360) % 2 : 2;
        if (phase === 0) {
          hrV = 172 + (r() - 0.5) * 4;
          spd = (summary.avgSpeedMps ?? 3.3) * 1.25;
        } else if (phase === 1) {
          hrV = 150 + (r() - 0.5) * 4;
          spd = (summary.avgSpeedMps ?? 3.3) * 0.75;
        }
      } else {
        // cardiac drift in the second half
        hrV += t > summary.durationSec / 2 ? 3 : 0;
      }
      hr.push(Math.round(hrV));
      speed.push(summary.avgSpeedMps ? Math.round(spd * 100) / 100 : null);
      cadence.push(summary.avgCadence ? Math.round(summary.avgCadence + (r() - 0.5) * 4) : null);
      altitude.push(summary.sport === "running" ? Math.round(120 + 15 * Math.sin(t / 400)) : null);
      cum += spd * interval;
      dist.push(summary.distanceM ? Math.round(cum) : null);
      gct.push(summary.sport === "running" ? Math.round(245 + (r() - 0.5) * 10) : null);
      vo.push(summary.sport === "running" ? Math.round((8.2 + (r() - 0.5) * 0.6) * 10) / 10 : null);
      stride.push(
        summary.sport === "running" && spd
          ? Math.round((spd / ((summary.avgCadence ?? 172) / 60)) * 100) / 100
          : null,
      );
    }
    const laps: GarminActivityDetails["laps"] = [];
    const lapLen = isIntervals ? 360 : 300;
    for (let s = 0; s < summary.durationSec; s += lapLen) {
      const d = Math.min(lapLen, summary.durationSec - s);
      laps.push({
        startTime: new Date(Date.parse(summary.startTime) + s * 1000).toISOString(),
        durationSec: d,
        distanceM: summary.avgSpeedMps ? Math.round(summary.avgSpeedMps * d) : null,
        avgHr: summary.avgHr,
        maxHr: summary.maxHr,
        avgSpeedMps: summary.avgSpeedMps,
        avgPowerW: summary.avgPowerW,
        avgCadence: summary.avgCadence,
        elevationGainM: 0,
      });
    }
    return {
      ...summary,
      laps,
      streams: {
        sampleIntervalSec: interval,
        hr,
        speedMps: speed,
        cadence,
        altitudeM: altitude,
        distanceM: dist,
        ...(summary.sport === "running"
          ? { gctMs: gct, verticalOscillationMm: vo, strideLengthM: stride }
          : {}),
      },
      runningDynamics:
        summary.sport === "running"
          ? {
              avgStrideLengthM: 1.15,
              avgGctMs: 245,
              avgVerticalOscillationMm: 8.2,
              avgVerticalRatio: 7.1,
              gctBalance: 50.2,
            }
          : null,
      temperatureC: Math.round(12 + r() * 12),
    };
  }
}
