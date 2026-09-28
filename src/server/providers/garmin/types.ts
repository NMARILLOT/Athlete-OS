import type { IsoDate, IsoDateTime } from "@/domain/core/dates";
import type { CardioWorkoutSpec } from "@/domain/cardio";

/**
 * GarminProvider — abstract interface (spec §72, ADR-011).
 * Endpoints are NOT invented here: `GarminOfficialProvider` is implemented against the official
 * Garmin Connect Developer Program documentation once credentials exist. Until then the mock provider
 * produces realistic data and the app never depends on a scraper.
 */
export interface GarminActivitySummary {
  externalId: string;
  sport: string;
  subSport?: string | null;
  startTime: IsoDateTime;
  /** Seconds east of UTC at the activity's location (Garmin: startTimeOffsetInSeconds). */
  utcOffsetSec?: number | null;
  durationSec: number;
  distanceM?: number | null;
  avgHr?: number | null;
  maxHr?: number | null;
  avgSpeedMps?: number | null;
  avgPowerW?: number | null;
  avgCadence?: number | null;
  elevationGainM?: number | null;
  calories?: number | null;
  deviceName?: string | null;
  deviceSerial?: string | null;
  /** Raw vendor payload kept verbatim for reprocessing (raw_payloads). */
  raw: unknown;
}

export interface GarminActivityDetails extends GarminActivitySummary {
  laps: Array<{
    startTime: IsoDateTime;
    durationSec: number;
    distanceM?: number | null;
    avgHr?: number | null;
    maxHr?: number | null;
    avgSpeedMps?: number | null;
    avgPowerW?: number | null;
    avgCadence?: number | null;
    elevationGainM?: number | null;
  }>;
  /** Streams sampled at a fixed interval; nulls where the device had no value (never invented). */
  streams: {
    sampleIntervalSec: number;
    hr?: Array<number | null>;
    speedMps?: Array<number | null>;
    powerW?: Array<number | null>;
    cadence?: Array<number | null>;
    altitudeM?: Array<number | null>;
    distanceM?: Array<number | null>;
    gctMs?: Array<number | null>;
    verticalOscillationMm?: Array<number | null>;
    strideLengthM?: Array<number | null>;
  };
  runningDynamics?: {
    avgStrideLengthM?: number | null;
    avgGctMs?: number | null;
    avgVerticalOscillationMm?: number | null;
    avgVerticalRatio?: number | null;
    gctBalance?: number | null;
  } | null;
  temperatureC?: number | null;
}

export interface GarminDailyHealth {
  date: IsoDate;
  sleepHours?: number | null;
  sleepScore?: number | null;
  restingHr?: number | null;
  hrvRmssd?: number | null;
  stress?: number | null;
  bodyBattery?: number | null;
  respiration?: number | null;
  vo2maxEst?: number | null;
  lthr?: number | null;
  raw: unknown;
}

export interface GarminWorkoutPushResult {
  garminWorkoutId: string;
  scheduledFor: IsoDate | null;
  status: "synced" | "pending" | "failed";
  message?: string;
}

export interface GarminProvider {
  readonly name: "mock" | "official";
  isConnected(userId: string): Promise<boolean>;
  getActivities(
    userId: string,
    range: { from: IsoDateTime; to: IsoDateTime },
  ): Promise<GarminActivitySummary[]>;
  getActivity(userId: string, externalId: string): Promise<GarminActivityDetails | null>;
  getHealthData(
    userId: string,
    range: { from: IsoDate; to: IsoDate },
  ): Promise<GarminDailyHealth[]>;
  createWorkout(userId: string, spec: CardioWorkoutSpec): Promise<GarminWorkoutPushResult>;
  scheduleWorkout(
    userId: string,
    garminWorkoutId: string,
    date: IsoDate,
  ): Promise<GarminWorkoutPushResult>;
  disconnect(userId: string): Promise<void>;
}
