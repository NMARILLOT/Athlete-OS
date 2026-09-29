import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { seedCatalog } from "@/db/seed";
import { createTestDb, type TestDb } from "@/db/test-db";
import type { CurrentUser } from "@/server/auth/types";
import { getTodayView } from "@/server/services/today.service";

vi.mock("server-only", () => ({}));

/**
 * A strength session started days ago and never closed (phone died) must keep its "Reprendre"
 * entry point on Today until it is finished — otherwise it stays in_progress forever, invisible.
 */
const USER: CurrentUser = {
  id: "00000000-0000-4000-8000-0000000000d1",
  email: "d@example.test",
  timezone: "Europe/Paris",
  displayName: "D",
  onboardingCompletedAt: null,
};
const NOW = new Date("2026-09-28T07:30:00.000Z"); // Monday 09:30 Paris
const STALE_ID = "20000000-0000-4000-8000-000000000001";

let handle: TestDb;

beforeAll(async () => {
  handle = await createTestDb();
  await handle.db.insert(schema.users).values({ id: USER.id, email: USER.email });
  await seedCatalog(handle.db);
});

afterAll(async () => {
  await handle.close();
});

describe("today: in-progress session", () => {
  it("surfaces an in_progress strength workout older than yesterday", async () => {
    await handle.db.insert(schema.workouts).values({
      id: STALE_ID,
      userId: USER.id,
      type: "strength",
      source: "planned_user",
      status: "in_progress",
      date: "2026-09-23", // five days ago
      startAt: new Date("2026-09-23T17:00:00.000Z"),
      title: "Lower A",
      plannedIntensity: "moderate",
      intensitySource: "ENGINE",
      expectedRpe: 7.5,
    });
    const view = await getTodayView(handle.db, USER, NOW);
    expect(view.inProgressWorkoutId).toBe(STALE_ID);
    expect(view.inProgressWorkoutType).toBe("strength");
  });

  it("ignores in_progress workouts of other types and done workouts", async () => {
    await handle.db.delete(schema.workouts);
    await handle.db.insert(schema.workouts).values({
      userId: USER.id,
      type: "crossfit",
      source: "planned_user",
      status: "in_progress",
      date: "2026-09-27",
      title: "WOD",
      intensitySource: "USER",
    });
    const view = await getTodayView(handle.db, USER, NOW);
    expect(view.inProgressWorkoutId).toBeNull();
    expect(view.inProgressWorkoutType).toBeNull();
  });
});
