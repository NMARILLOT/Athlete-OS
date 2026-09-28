import { describe, expect, it } from "vitest";
import {
  COMPARABLE_GROUP_VERSION,
  classifyComparableGroup,
  isComparable,
  type ComparableSessionInput,
} from "./comparable";

const easyRun: ComparableSessionInput = {
  modality: "running",
  durationMin: 58,
  distanceM: 10_400,
  elevationGainM: 60,
  intensity: "easy",
  temperatureC: 14,
};

describe("comparable groups (spec §30)", () => {
  it("is version pinned", () => {
    expect(COMPARABLE_GROUP_VERSION).toBe("comparable_group_v1");
  });

  it("composes intensity, modality, terrain, venue and duration bucket", () => {
    expect(classifyComparableGroup(easyRun)).toBe("easy_run_flat_45_75min");
    expect(
      classifyComparableGroup({
        ...easyRun,
        durationMin: 95,
        distanceM: 15_000,
        elevationGainM: 320,
      }),
    ).toBe("easy_run_hilly_75_120min");
    expect(
      classifyComparableGroup({
        modality: "bike",
        durationMin: 60,
        intensity: "easy",
        indoor: true,
      }),
    ).toBe("easy_bike_indoor_45_75min");
    expect(
      classifyComparableGroup({
        modality: "bike",
        durationMin: 150,
        distanceM: 70_000,
        elevationGainM: 900,
        intensity: "easy",
        indoor: false,
      }),
    ).toBe("easy_bike_hilly_outdoor_over120min");
    expect(
      classifyComparableGroup({
        modality: "row",
        durationMin: 40,
        intensity: "hard",
        indoor: true,
      }),
    ).toBe("hard_row_indoor_under45min");
    expect(classifyComparableGroup({ modality: "ski", durationMin: 30, intensity: "easy" })).toBe(
      "easy_ski_under45min",
    );
    expect(
      classifyComparableGroup({ modality: "walking", durationMin: 45, intensity: "easy" }),
    ).toBe("easy_walk_45_75min");
  });

  it("omits terrain when distance or elevation is unknown", () => {
    expect(
      classifyComparableGroup({ modality: "running", durationMin: 50, intensity: "moderate" }),
    ).toBe("moderate_run_45_75min");
    expect(
      classifyComparableGroup({
        modality: "running",
        durationMin: 50,
        distanceM: 9000,
        intensity: "hard",
      }),
    ).toBe("hard_run_45_75min");
  });

  it("requires the same group, close temperature and distance within 25 %", () => {
    expect(isComparable(easyRun, { ...easyRun, distanceM: 9800, temperatureC: 20 })).toBe(true);
    expect(isComparable(easyRun, { ...easyRun, temperatureC: 24 })).toBe(false);
    expect(isComparable(easyRun, { ...easyRun, distanceM: 7500, elevationGainM: 40 })).toBe(false);
    expect(isComparable(easyRun, { ...easyRun, durationMin: 80 })).toBe(false);
    expect(
      isComparable(easyRun, {
        ...easyRun,
        temperatureC: null,
        distanceM: null,
        elevationGainM: null,
      }),
    ).toBe(false);
    expect(
      isComparable(
        { ...easyRun, distanceM: null, elevationGainM: null },
        { ...easyRun, temperatureC: null, distanceM: null, elevationGainM: null },
      ),
    ).toBe(true);
  });
});
