import "server-only";
import { createHash } from "node:crypto";
import { Decoder, Stream } from "@garmin/fitsdk";
import type { GarminActivityDetails } from "@/server/providers/garmin/types";

export const FIT_PARSER_VERSION = "fit_parser_v1" as const;

/**
 * Sports whose FIT cadence is recorded per foot ("rpm"): the summary, the laps AND the record
 * stream are all doubled to steps per minute so one activity never shows two units (spec §15/§17).
 */
const PER_FOOT_CADENCE_SPORTS: ReadonlySet<string> = new Set([
  "running",
  "trail_running",
  "track_running",
  "walking",
  "hiking",
]);

/**
 * FitParser (spec §73): tolerant extraction from a FIT file using the official Garmin FIT SDK.
 * Every field is optional; absent fields stay null — a metric is never invented (spec §15).
 * Output is the same normalised shape as the Garmin provider so the import pipeline is shared.
 */
export interface ParsedFit {
  activity: GarminActivityDetails;
  sha256: string;
  fileIdSerial: string | null;
  timeCreated: string | null;
  warnings: string[];
}

type Mesg = Record<string, unknown>;

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

function iso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
}

export function parseFit(bytes: Uint8Array | ArrayBuffer | Buffer): ParsedFit {
  const buf = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  const stream = Stream.fromByteArray(Array.from(buf));
  if (!Decoder.isFIT(stream)) throw new Error("Not a FIT file");
  const decoder = new Decoder(stream);
  const { messages, errors } = decoder.read({
    convertTypesToStrings: true,
    convertDateTimesToDates: true,
    includeUnknownData: false,
    mergeHeartRates: true,
  });
  const warnings: string[] = errors
    .map((e: unknown) => (e instanceof Error ? e.message : String(e)))
    .slice(0, 10);
  const m = messages as Record<string, Mesg[] | undefined>;

  const fileId = m.fileIdMesgs?.[0] ?? {};
  const session = m.sessionMesgs?.[0] ?? {};
  const laps = m.lapMesgs ?? [];
  const records = m.recordMesgs ?? [];
  const device =
    m.deviceInfoMesgs?.find((d) => num(d.deviceIndex) === 0) ?? m.deviceInfoMesgs?.[0] ?? {};

  const startTime = iso(session.startTime) ?? iso(records[0]?.timestamp) ?? iso(fileId.timeCreated);
  if (!startTime) throw new Error("FIT file has no session start time");
  const durationSec =
    num(session.totalTimerTime) ??
    num(session.totalElapsedTime) ??
    (records.length
      ? Math.max(
          0,
          (Date.parse(iso(records[records.length - 1]?.timestamp) ?? startTime) -
            Date.parse(startTime)) /
            1000,
        )
      : 0);
  const sport = str(session.sport) ?? "generic";
  const subSport = str(session.subSport);
  const avgSpeed = num(session.enhancedAvgSpeed) ?? num(session.avgSpeed);
  const cadenceFactor = PER_FOOT_CADENCE_SPORTS.has(sport.toLowerCase()) ? 2 : 1;

  // Streams: resample records to a fixed interval (median dt, min 1 s) with nulls for gaps.
  const t0 = Date.parse(startTime);
  const stamped = records
    .map((r) => ({
      t: iso(r.timestamp) ? (Date.parse(iso(r.timestamp) as string) - t0) / 1000 : null,
      r,
    }))
    .filter((x): x is { t: number; r: Mesg } => x.t !== null && x.t >= 0);
  const dts: number[] = [];
  for (let i = 1; i < stamped.length; i++)
    dts.push((stamped[i]?.t ?? 0) - (stamped[i - 1]?.t ?? 0));
  const sortedDts = dts.filter((d) => d > 0).sort((a, b) => a - b);
  const interval = Math.max(1, Math.round(sortedDts[Math.floor(sortedDts.length / 2)] ?? 1));
  const n = Math.max(0, Math.floor(durationSec / interval) + 1);
  const mk = () => new Array<number | null>(n).fill(null);
  const hr = mk();
  const speed = mk();
  const cadence = mk();
  const power = mk();
  const altitude = mk();
  const distance = mk();
  const gct = mk();
  const vo = mk();
  const stride = mk();
  let hasHr = false;
  let hasSpeed = false;
  let hasCad = false;
  let hasPow = false;
  let hasAlt = false;
  let hasDist = false;
  let hasGct = false;
  let hasVo = false;
  let hasStride = false;
  for (const { t, r } of stamped) {
    const i = Math.round(t / interval);
    if (i < 0 || i >= n) continue;
    const h = num(r.heartRate);
    if (h !== null) {
      hr[i] = h;
      hasHr = true;
    }
    const s = num(r.enhancedSpeed) ?? num(r.speed);
    if (s !== null) {
      speed[i] = s;
      hasSpeed = true;
    }
    const c = num(r.cadence);
    if (c !== null) {
      cadence[i] = c * cadenceFactor;
      hasCad = true;
    }
    const p = num(r.power);
    if (p !== null) {
      power[i] = p;
      hasPow = true;
    }
    const a = num(r.enhancedAltitude) ?? num(r.altitude);
    if (a !== null) {
      altitude[i] = a;
      hasAlt = true;
    }
    const d = num(r.distance);
    if (d !== null) {
      distance[i] = d;
      hasDist = true;
    }
    const g = num(r.stanceTime);
    if (g !== null) {
      gct[i] = g;
      hasGct = true;
    }
    const v = num(r.verticalOscillation);
    if (v !== null) {
      vo[i] = v;
      hasVo = true;
    }
    const sl = num(r.stepLength);
    if (sl !== null) {
      stride[i] = sl / 1000; // mm → m
      hasStride = true;
    }
  }

  const activity: GarminActivityDetails = {
    externalId: "", // set by the import service (sha256 of the bytes)
    sport,
    subSport,
    startTime,
    utcOffsetSec: null,
    durationSec: Math.round(durationSec),
    distanceM: num(session.totalDistance),
    avgHr: num(session.avgHeartRate),
    maxHr: num(session.maxHeartRate),
    avgSpeedMps: avgSpeed,
    avgPowerW: num(session.avgPower),
    avgCadence:
      num(session.avgCadence) !== null ? (num(session.avgCadence) as number) * cadenceFactor : null,
    elevationGainM: num(session.totalAscent),
    calories: num(session.totalCalories),
    deviceName: str(device.productName) ?? str(device.garminProduct) ?? str(device.product),
    deviceSerial: str(fileId.serialNumber) ?? str(device.serialNumber),
    raw: {
      fileId: sanitize(fileId),
      session: sanitize(session),
      parserVersion: FIT_PARSER_VERSION,
    },
    laps: laps.map((l) => ({
      startTime: iso(l.startTime) ?? startTime,
      durationSec: Math.round(num(l.totalTimerTime) ?? num(l.totalElapsedTime) ?? 0),
      distanceM: num(l.totalDistance),
      avgHr: num(l.avgHeartRate),
      maxHr: num(l.maxHeartRate),
      avgSpeedMps: num(l.enhancedAvgSpeed) ?? num(l.avgSpeed),
      avgPowerW: num(l.avgPower),
      avgCadence: num(l.avgCadence) !== null ? (num(l.avgCadence) as number) * cadenceFactor : null,
      elevationGainM: num(l.totalAscent),
    })),
    streams: {
      sampleIntervalSec: interval,
      ...(hasHr ? { hr } : {}),
      ...(hasSpeed ? { speedMps: speed } : {}),
      ...(hasCad ? { cadence } : {}),
      ...(hasPow ? { powerW: power } : {}),
      ...(hasAlt ? { altitudeM: altitude } : {}),
      ...(hasDist ? { distanceM: distance } : {}),
      ...(hasGct ? { gctMs: gct } : {}),
      ...(hasVo ? { verticalOscillationMm: vo } : {}),
      ...(hasStride ? { strideLengthM: stride } : {}),
    },
    runningDynamics:
      sport === "running" &&
      (num(session.avgStanceTime) !== null ||
        num(session.avgVerticalOscillation) !== null ||
        num(session.avgStepLength) !== null)
        ? {
            avgStrideLengthM:
              num(session.avgStepLength) !== null
                ? (num(session.avgStepLength) as number) / 1000
                : null,
            avgGctMs: num(session.avgStanceTime),
            avgVerticalOscillationMm: num(session.avgVerticalOscillation),
            avgVerticalRatio: num(session.avgVerticalRatio),
            gctBalance: num(session.avgStanceTimeBalance),
          }
        : null,
    temperatureC: num(session.avgTemperature),
  };
  const sha256 = createHash("sha256").update(buf).digest("hex");
  activity.externalId = sha256;
  return {
    activity,
    sha256,
    fileIdSerial: str(fileId.serialNumber),
    timeCreated: iso(fileId.timeCreated),
    warnings,
  };
}

/** Keep raw payloads JSON-safe (Dates → ISO, drop functions/undefined). */
function sanitize(m: Mesg): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (v === undefined || typeof v === "function") continue;
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}
