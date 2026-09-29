import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { heuristicIntent, MockAiProvider } from "@/server/providers/ai/mock";
import { hashInput } from "@/server/providers/ai/types";
import { freeWindows } from "@/server/providers/calendar";
import { GarminMockProvider } from "@/server/providers/garmin/mock";
import { secretMatches, bearerFrom } from "@/server/auth/secret";

describe("heuristic intent parser", () => {
  const T = "2026-10-01";
  const T1 = "2026-10-02";
  it("maps spec §32/§33 sentences to bounded intents", () => {
    expect(heuristicIntent("J'ai envie de courir aujourd'hui", T, T1)).toMatchObject({
      kind: "want_run",
      date: T,
    });
    expect(heuristicIntent("J'aimerais faire du CrossFit demain", T, T1)).toMatchObject({
      kind: "want_crossfit",
      date: T1,
    });
    expect(heuristicIntent("Fais-moi un gros Hyrox ce soir", T, T1)).toMatchObject({
      kind: "want_hyrox",
      intensity: "hard",
    });
    expect(heuristicIntent("Aujourd'hui je n'ai aucune envie de musculation", T, T1)).toMatchObject(
      { kind: "no_strength" },
    );
    expect(heuristicIntent("Mes jambes sont mortes", T, T1)).toMatchObject({ kind: "no_legs" });
    expect(heuristicIntent("J'ai 90 minutes", T, T1)).toMatchObject({
      kind: "have_time",
      availableMinutes: 90,
    });
    expect(heuristicIntent("Je veux juste bouger un peu, tranquille", T, T1)).toMatchObject({
      kind: "just_move",
      intensity: "easy",
    });
    expect(heuristicIntent("blabla", T, T1).kind).toBe("custom");
  });

  it("mock provider returns validated structures with metadata", async () => {
    const p = new MockAiProvider();
    const wod = await p.parseWod({ text: "Fran\n21-15-9\nthrusters 43/30\npull-ups" });
    expect(wod.output.parser).toBe("HEURISTIC");
    expect(wod.meta.provider).toBe("mock");
    expect(wod.meta.inputHash).toBe(
      hashInput({ text: "Fran\n21-15-9\nthrusters 43/30\npull-ups" }),
    );
    const ex = await p.explain({
      rulesTriggered: [],
      primaryTitle: "x",
      alternatives: [],
      templatedExplanation: "Parce que.",
      context: {},
    });
    expect(ex.output.text).toBe("Parce que.");
  });

  it("hashInput is deterministic and order-independent", () => {
    expect(hashInput({ a: 1, b: "x" })).toBe(hashInput({ b: "x", a: 1 }));
    expect(hashInput({ a: 1 })).not.toBe(hashInput({ a: 2 }));
  });
});

describe("calendar free windows", () => {
  it("derives availability from busy blocks without exposing titles", () => {
    const free = freeWindows([
      { startMinute: 9 * 60, endMinute: 12 * 60 },
      { startMinute: 14 * 60, endMinute: 18 * 60 },
    ]);
    expect(free).toEqual([
      { startMinute: 360, endMinute: 540 },
      { startMinute: 720, endMinute: 840 },
      { startMinute: 1080, endMinute: 1320 },
    ]);
  });
});

describe("Garmin mock provider", () => {
  it("produces deterministic, realistic activities and health data", async () => {
    const g = new GarminMockProvider();
    const acts = await g.getActivities("u", {
      from: "2026-09-21T00:00:00Z",
      to: "2026-09-27T23:59:59Z",
    });
    expect(acts.map((a) => a.sport)).toEqual(["running", "running", "running", "cycling"]);
    const again = await g.getActivities("u", {
      from: "2026-09-21T00:00:00Z",
      to: "2026-09-27T23:59:59Z",
    });
    expect(again).toEqual(acts);
    const details = await g.getActivity("u", acts[0]!.externalId);
    expect(details?.streams.hr?.length).toBeGreaterThan(100);
    expect(details?.streams.hr?.[0]).toBeNull();
    expect(details?.laps.length).toBeGreaterThan(3);
    const health = await g.getHealthData("u", { from: "2026-09-21", to: "2026-09-27" });
    expect(health).toHaveLength(7);
    expect(health[0]?.restingHr).toBeGreaterThan(40);
    const push = await g.createWorkout("u", {
      modality: "running",
      kind: "zone2",
      title: "Z2",
      steps: [],
    });
    expect(push.status).toBe("synced");
    expect((await g.scheduleWorkout("u", push.garminWorkoutId, "2026-10-02")).scheduledFor).toBe(
      "2026-10-02",
    );
    expect((await g.scheduleWorkout("u", "nope", "2026-10-02")).status).toBe("failed");
  });
});

describe("Garmin provider factory", () => {
  const PROD_ENV = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://example.invalid/athlete",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    ALLOWED_EMAILS: "a@example.test",
    GARMIN_PROVIDER: "mock",
  } as const;

  async function loadGarmin() {
    vi.resetModules();
    return import("@/server/providers/garmin");
  }

  it("refuses the mock in production unless FLAG_GARMIN_MOCK_IN_PROD is explicitly true", async () => {
    try {
      for (const [k, v] of Object.entries(PROD_ENV)) vi.stubEnv(k, v);
      vi.stubEnv("FLAG_GARMIN_MOCK_IN_PROD", "");
      const refused = await loadGarmin();
      expect(refused.garminMockAllowed()).toBe(false);
      // Fails closed: the official stub, which answers "not configured" instead of inventing data.
      expect(refused.garminProvider().name).toBe("official");
      await expect(
        refused
          .garminProvider()
          .getActivities("u", { from: "2026-09-21T00:00:00Z", to: "2026-09-27T23:59:59Z" }),
      ).rejects.toThrow();

      vi.stubEnv("FLAG_GARMIN_MOCK_IN_PROD", "true");
      const allowed = await loadGarmin();
      expect(allowed.garminMockAllowed()).toBe(true);
      expect(allowed.garminProvider().name).toBe("mock");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("serves the mock outside production", async () => {
    try {
      vi.stubEnv("NODE_ENV", "test");
      vi.stubEnv("VERCEL", "");
      vi.stubEnv("GARMIN_PROVIDER", "mock");
      const dev = await loadGarmin();
      expect(dev.garminMockAllowed()).toBe(true);
      expect(dev.garminProvider().name).toBe("mock");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("secret comparison", () => {
  it("fails closed and compares in constant time", () => {
    expect(secretMatches("abc", undefined)).toBe(false);
    expect(secretMatches(undefined, "abc")).toBe(false);
    expect(secretMatches("abc", "abc")).toBe(true);
    expect(secretMatches("abd", "abc")).toBe(false);
    expect(bearerFrom("Bearer  tok")).toBe("tok");
    expect(bearerFrom("Basic x")).toBeNull();
  });
});
