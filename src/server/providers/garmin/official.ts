import "server-only";
import { NotConfiguredError } from "@/server/errors";
import type { GarminProvider } from "./types";

/**
 * Official Garmin provider — STUB (ADR-011). The Garmin Connect Developer Program requires an
 * application review; the Health / Activity / Training API endpoints, OAuth 2.0 PKCE flow and push
 * notification callbacks must be implemented from the official documentation once credentials exist.
 * Until then every method throws NotConfiguredError so the app degrades explicitly, never silently.
 */
export class GarminOfficialProvider implements GarminProvider {
  readonly name = "official" as const;
  private fail(): never {
    throw new NotConfiguredError("Garmin (provider officiel)");
  }
  async isConnected(): Promise<boolean> {
    return false;
  }
  async getActivities(): Promise<never> {
    return this.fail();
  }
  async getActivity(): Promise<never> {
    return this.fail();
  }
  async getHealthData(): Promise<never> {
    return this.fail();
  }
  async createWorkout(): Promise<never> {
    return this.fail();
  }
  async scheduleWorkout(): Promise<never> {
    return this.fail();
  }
  async disconnect(): Promise<void> {
    return;
  }
}
