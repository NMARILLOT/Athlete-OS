import "server-only";
import type { IsoDateTime } from "@/domain/core/dates";
import { env } from "@/server/env";
import { NotConfiguredError } from "@/server/errors";

/** Normalised body-composition measurement (spec §25–26). Individual readings are noisy; trends matter. */
export interface BodyCompositionMeasurement {
  measuredAt: IsoDateTime;
  weightKg: number;
  bodyFatPct?: number | null;
  muscleMassKg?: number | null;
  waterPct?: number | null;
  boneMassKg?: number | null;
  extra?: Record<string, number>;
  source: "SCALE" | "GARMIN" | "MANUAL";
  provider: string;
  externalId?: string | null;
  raw?: unknown;
}

export interface BodyCompositionProvider {
  readonly name: "manual" | "withings" | "garmin" | "webhook";
  /** Pull new measurements since a timestamp (providers with an API). */
  fetchSince(userId: string, since: IsoDateTime | null): Promise<BodyCompositionMeasurement[]>;
  /** Normalise a webhook/manual payload into the common model. */
  normalise(payload: unknown): BodyCompositionMeasurement | null;
}

/** Manual provider: nothing to fetch; the "+" palette records measurements directly. */
export class ManualBodyCompositionProvider implements BodyCompositionProvider {
  readonly name = "manual" as const;
  async fetchSince(): Promise<BodyCompositionMeasurement[]> {
    return [];
  }
  normalise(payload: unknown): BodyCompositionMeasurement | null {
    if (!payload || typeof payload !== "object") return null;
    const p = payload as Record<string, unknown>;
    const weight = Number(p.weightKg);
    if (!Number.isFinite(weight) || weight <= 0) return null;
    return {
      measuredAt: typeof p.measuredAt === "string" ? p.measuredAt : new Date().toISOString(),
      weightKg: weight,
      bodyFatPct: numOrNull(p.bodyFatPct),
      muscleMassKg: numOrNull(p.muscleMassKg),
      waterPct: numOrNull(p.waterPct),
      boneMassKg: numOrNull(p.boneMassKg),
      source: "MANUAL",
      provider: "manual",
      externalId: null,
    };
  }
}

function numOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

class NotConfiguredBodyCompositionProvider implements BodyCompositionProvider {
  constructor(readonly name: "withings" | "garmin") {}
  async fetchSince(): Promise<BodyCompositionMeasurement[]> {
    throw new NotConfiguredError(`Balance (${this.name})`);
  }
  normalise(): BodyCompositionMeasurement | null {
    throw new NotConfiguredError(`Balance (${this.name})`);
  }
}

let instance: BodyCompositionProvider | null = null;
export function bodyCompositionProvider(): BodyCompositionProvider {
  if (instance) return instance;
  const p = env().BODYCOMP_PROVIDER;
  instance =
    p === "manual"
      ? new ManualBodyCompositionProvider()
      : new NotConfiguredBodyCompositionProvider(p);
  return instance;
}
