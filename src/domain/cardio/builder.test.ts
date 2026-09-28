import { describe, expect, it } from "vitest";
import {
  CARDIO_PRESETS,
  CARDIO_PRESET_KINDS,
  CardioStepSchema,
  CardioWorkoutSpecSchema,
  estimateDurationMin,
  expectedLoadProfile,
  flattenSteps,
  toGarminWorkoutDraft,
  type CardioWorkoutSpec,
} from "./builder";
import { zonesFromLthr } from "./zones";
import type { LoadProfile } from "../engine/types";
import { SESSION_KIND_VALUES } from "../core";

describe("cardio step schema (spec §80)", () => {
  it("is strict and recursive", () => {
    const ok = CardioStepSchema.safeParse({
      kind: "repeat",
      repeat: {
        times: 3,
        steps: [{ kind: "work", durationSec: 480, target: { type: "hr_zone", zone: 4 } }],
      },
    });
    expect(ok.success).toBe(true);
    expect(
      CardioStepSchema.safeParse({ kind: "work", durationSec: 60, physiology: "x" }).success,
    ).toBe(false);
    expect(
      CardioStepSchema.safeParse({ kind: "work", durationSec: 60, target: { type: "hr_zone" } })
        .success,
    ).toBe(false);
    expect(CardioStepSchema.safeParse({ kind: "repeat" }).success).toBe(false);
    expect(
      CardioStepSchema.safeParse({ kind: "work", durationSec: 60, repeat: { times: 2, steps: [] } })
        .success,
    ).toBe(false);
  });

  it("ships presets for every cardio candidate kind, all valid", () => {
    expect(Object.keys(CARDIO_PRESETS).sort()).toEqual([...CARDIO_PRESET_KINDS].sort());
    for (const kind of CARDIO_PRESET_KINDS) {
      expect(SESSION_KIND_VALUES).toContain(kind);
      const parsed = CardioWorkoutSpecSchema.safeParse(CARDIO_PRESETS[kind]);
      expect(parsed.success, kind).toBe(true);
    }
  });
});

describe("flatten + duration", () => {
  it("unrolls repeats", () => {
    const flat = flattenSteps(CARDIO_PRESETS.run_threshold.steps);
    expect(flat.map((s) => s.kind)).toEqual([
      "warmup",
      "work",
      "recovery",
      "work",
      "recovery",
      "work",
      "recovery",
      "cooldown",
    ]);
    expect(flat.every((s) => !("repeat" in s))).toBe(true);
  });

  it("estimates minutes, converting distance steps with a pace", () => {
    expect(estimateDurationMin(CARDIO_PRESETS.run_threshold)).toBe(50);
    expect(estimateDurationMin(CARDIO_PRESETS.run_vo2)).toBe(50);
    expect(estimateDurationMin(CARDIO_PRESETS.strides)).toBe(38);
    // 5 km at the default 5:30/km = 27.5 min + 20 min warm-up / cool-down
    expect(estimateDurationMin(CARDIO_PRESETS.test_run_5k)).toBe(47.5);
    expect(estimateDurationMin(CARDIO_PRESETS.test_run_5k, { paceSecKmForDistance: 240 })).toBe(40);
    // 2 km row at 2:10/500 m = 8.7 min + 15
    expect(estimateDurationMin(CARDIO_PRESETS.test_row_2k)).toBe(23.7);
  });
});

describe("expected load profile", () => {
  it("is assignable to the engine LoadProfile contract", () => {
    const profile: LoadProfile = expectedLoadProfile(CARDIO_PRESETS.run_easy_60);
    expect(profile.heavyStrength).toBe(false);
    expect(profile.modality).toBe("running");
  });

  it("easy run 60 = reference Z2 run, one aerobic_easy credit, ~10.9 impact units", () => {
    const p = expectedLoadProfile(CARDIO_PRESETS.run_easy_60);
    expect(p.intensity).toBe("easy");
    expect(p.expectedCredits).toEqual({ aerobic_easy: 1 });
    expect(p.loadVector).toEqual({
      cardiovascular: 3,
      muscular_lower: 2.5,
      muscular_upper: 0,
      impact: 5,
      eccentric: 2,
      technical: 0,
    });
    expect(p.impactUnits).toBeCloseTo(10.91, 2);
    expect(p.durationMin).toBe(60);
    expect(p.patterns).toEqual({ locomotion: 4 });
  });

  it("scales easy sessions by sqrt(minutes/60) and grants aerobic_long from 75 min", () => {
    const short = expectedLoadProfile(CARDIO_PRESETS.run_easy_45);
    expect(short.loadVector.cardiovascular).toBe(2.6);
    expect(short.expectedCredits).toEqual({ aerobic_easy: 1 });
    const long = expectedLoadProfile(CARDIO_PRESETS.run_long_90);
    expect(long.expectedCredits).toEqual({ aerobic_easy: 1, aerobic_long: 1 });
    expect(long.loadVector.cardiovascular).toBe(3.7);
    const veryLong = expectedLoadProfile(CARDIO_PRESETS.bike_long_120);
    expect(veryLong.loadVector.cardiovascular).toBe(4.2); // 3 × 1.4 (clamped)
    expect(veryLong.impactUnits).toBe(0);
  });

  it("classifies hard sessions and credits threshold vs vo2max", () => {
    const thr = expectedLoadProfile(CARDIO_PRESETS.run_threshold);
    expect(thr.intensity).toBe("hard");
    expect(thr.expectedCredits).toEqual({ threshold: 1 });
    expect(thr.loadVector).toEqual({
      cardiovascular: 8,
      muscular_lower: 5,
      muscular_upper: 0,
      impact: 6,
      eccentric: 3,
      technical: 1,
    });

    const vo2 = expectedLoadProfile(CARDIO_PRESETS.run_vo2);
    expect(vo2.intensity).toBe("hard");
    expect(vo2.expectedCredits).toEqual({ vo2max: 1 });
    expect(vo2.loadVector.cardiovascular).toBe(9);

    // Z4 intervals on the bike are threshold work, not VO2max
    const bike = expectedLoadProfile(CARDIO_PRESETS.bike_intervals);
    expect(bike.intensity).toBe("hard");
    expect(bike.expectedCredits).toEqual({ threshold: 1 });
    expect(bike.loadVector).toEqual({
      cardiovascular: 8,
      muscular_lower: 5,
      muscular_upper: 0,
      impact: 0,
      eccentric: 0,
      technical: 0,
    });

    const test5k = expectedLoadProfile(CARDIO_PRESETS.test_run_5k);
    expect(test5k.intensity).toBe("hard");
    expect(test5k.expectedCredits).toEqual({ vo2max: 0.7, threshold: 0.5 });
    expect(expectedLoadProfile(CARDIO_PRESETS.test_row_2k).expectedCredits).toEqual({
      vo2max: 0.7,
    });
  });

  it("tempo is moderate with a threshold credit; a Z4 work step alone makes a session hard", () => {
    const tempo = expectedLoadProfile(CARDIO_PRESETS.run_tempo);
    expect(tempo.intensity).toBe("moderate");
    expect(tempo.expectedCredits).toEqual({ threshold: 1 });
    const free: CardioWorkoutSpec = {
      modality: "running",
      kind: "free",
      title: "libre",
      steps: [
        { kind: "warmup", durationSec: 600, target: { type: "hr_zone", zone: 1 } },
        { kind: "work", durationSec: 600, target: { type: "hr_zone", zone: 4 } },
      ],
    };
    const p = expectedLoadProfile(free);
    expect(p.intensity).toBe("hard");
    expect(p.expectedCredits).toEqual({ threshold: 0.5 });
  });

  it("strides stay easy with a small power credit; recovery sessions are light", () => {
    const strides = expectedLoadProfile(CARDIO_PRESETS.strides);
    expect(strides.intensity).toBe("easy");
    expect(strides.expectedCredits).toEqual({ aerobic_easy: 0.84, power: 0.3 });

    const spin = expectedLoadProfile(CARDIO_PRESETS.recovery_spin_30);
    expect(spin.expectedCredits).toEqual({ aerobic_easy: 0.33, mobility_recovery: 0.7 });
    expect(spin.loadVector.cardiovascular).toBe(1.3);

    const walk = expectedLoadProfile(CARDIO_PRESETS.walk_45);
    expect(walk.expectedCredits).toEqual({ aerobic_easy: 0.3, mobility_recovery: 0.7 });
    expect(walk.impactUnits).toBeCloseTo(0.94, 2);
  });

  it("is deterministic", () => {
    expect(expectedLoadProfile(CARDIO_PRESETS.row_intervals)).toEqual(
      expectedLoadProfile(CARDIO_PRESETS.row_intervals),
    );
    expect(expectedLoadProfile(CARDIO_PRESETS.row_intervals).patterns).toEqual({
      locomotion: 2.67,
      horizontal_pull: 1.33,
    });
  });
});

describe("provider-neutral workout draft", () => {
  it("maps steps, nests repeats and keeps zone numbers without a zone set", () => {
    const draft = toGarminWorkoutDraft(CARDIO_PRESETS.run_threshold);
    expect(draft.sport).toBe("running");
    expect(draft.name).toBe("Seuil — 3 × 8 min");
    expect(draft.steps).toHaveLength(3);
    expect(draft.steps[0]).toEqual({
      stepType: "warmup",
      durationType: "time",
      durationValue: 600,
      targetType: "heart_rate_zone",
      targetValueLow: 1,
      targetValueHigh: 1,
    });
    const rep = draft.steps[1];
    expect(rep?.stepType).toBe("repeat");
    expect(rep?.repeatCount).toBe(3);
    expect(rep?.steps?.map((s) => s.stepType)).toEqual(["interval", "recovery"]);
    expect(rep?.steps?.[1]?.notes).toBe("trot facile");
  });

  it("resolves HR zones to bpm from a versioned zone set and maps distance / open steps", () => {
    const set = zonesFromLthr(170, "2026-02-01", "GARMIN");
    const draft = toGarminWorkoutDraft(CARDIO_PRESETS.test_run_5k, set);
    expect(draft.steps[0]).toMatchObject({
      targetType: "heart_rate",
      targetValueLow: 0,
      targetValueHigh: 144,
    });
    expect(draft.steps[1]).toMatchObject({
      stepType: "interval",
      durationType: "distance",
      durationValue: 5000,
      targetType: "open",
    });
    const bike = toGarminWorkoutDraft({
      modality: "bike",
      kind: "free",
      title: "power",
      steps: [{ kind: "work", target: { type: "power_w", min: 200, max: 220 } }],
    });
    expect(bike.sport).toBe("cycling");
    expect(bike.steps[0]).toMatchObject({
      durationType: "lap_button",
      durationValue: null,
      targetType: "power",
      targetValueLow: 200,
      targetValueHigh: 220,
    });
  });
});
