import "server-only";
import { env } from "@/server/env";
import { GarminMockProvider } from "./mock";
import { GarminOfficialProvider } from "./official";
import type { GarminProvider } from "./types";

export * from "./types";

let instance: GarminProvider | null = null;

/** Provider selected by GARMIN_PROVIDER (mock | official). */
export function garminProvider(): GarminProvider {
  if (instance) return instance;
  instance =
    env().GARMIN_PROVIDER === "official" ? new GarminOfficialProvider() : new GarminMockProvider();
  return instance;
}
