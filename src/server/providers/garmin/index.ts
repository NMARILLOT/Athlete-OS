import "server-only";
import { env, isProductionRuntime } from "@/server/env";
import { log } from "@/server/logging";
import { GarminMockProvider } from "./mock";
import { GarminOfficialProvider } from "./official";
import type { GarminProvider } from "./types";

export * from "./types";

let instance: GarminProvider | null = null;

const truthy = (v: string | undefined): boolean => v === "true" || v === "1" || v === "on";

/**
 * Whether the development mock may produce data in this runtime: always outside production; in
 * production / on Vercel only when FLAG_GARMIN_MOCK_IN_PROD is explicitly true (spec §14: the mock
 * is a dev tool — simulated activities never land in a real database by default).
 */
export function garminMockAllowed(): boolean {
  return !isProductionRuntime() || truthy(process.env.FLAG_GARMIN_MOCK_IN_PROD);
}

/**
 * Provider selected by GARMIN_PROVIDER (mock | official). In production the mock is refused unless
 * explicitly allowed: the official stub is returned instead, so every call degrades to
 * NotConfiguredError rather than inventing measured-looking data.
 */
export function garminProvider(): GarminProvider {
  if (instance) return instance;
  if (env().GARMIN_PROVIDER === "official") instance = new GarminOfficialProvider();
  else if (garminMockAllowed()) instance = new GarminMockProvider();
  else {
    log.warn("garmin.mock_refused_in_production", { provider: "mock" });
    instance = new GarminOfficialProvider();
  }
  return instance;
}
