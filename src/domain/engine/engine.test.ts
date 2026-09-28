import { describe, expect, it } from "vitest";
import { addDays } from "../core/dates";
import { checkPlacement, projectWeek, runEngine } from "./engine";
import {
  fixedClass,
  plannedFree,
  profileOfKind,
  scenario,
  session,
  typicalHistory,
} from "./fixtures";
import { isBonusOption, type Recommendation } from "./types";

const kinds = (r: Recommendation) => [
  r.primary.kind,
  ...r.alternatives.map((a) => a.kind),
  ...(r.bonus.kind === "none" ? [] : [r.bonus.kind]),
];
const vetoedKinds = (r: Recommendation) =>
  r.trace.candidates.filter((c) => c.vetoed).map((c) => c.kind);
const ruleIds = (r: Recommendation) => r.rulesTriggered.map((h) => h.ruleId);
const T = "2026-10-01"; // Thursday

describe("engine — spec §4 / §99-1: heavy squat + wall balls yesterday, front squats in today's class", () => {
  const input = scenario({
    today: T,
    history: [
      ...typicalHistory(T).filter((s) => s.date < addDays(T, -1)),
      session({ date: addDays(T, -1), profile: "heavy_squat_wallballs", kind: "crossfit" }),
    ],
    planned: [fixedClass({ date: T, profile: "front_squat_class" })],
  });
  const r = runEngine(input);

  it("keeps the fixed class as primary and never proposes heavy legs", () => {
    expect(r.primary.kind).toBe("crossfit_as_programmed");
    expect(r.primary.fixed).toBe(true);
    for (const k of kinds(r))
      expect([
        "strength_lower",
        "strength_full",
        "run_vo2",
        "run_threshold",
        "hyrox_hard",
      ]).not.toContain(k);
    expect(vetoedKinds(r)).toContain("strength_lower");
    expect(ruleIds(r)).toContain("HIGH_LOWER_BODY_FATIGUE");
  });

  it("explains the coverage and advises scaling the legs", () => {
    expect(r.explanation).toMatch(/couvre/i);
    expect(r.advice.some((a) => a.code === "SCALE_ADVICE")).toBe(true);
    expect(r.confidence.level).not.toBe("LOW");
  });

  it("offers only an easy, non-leg bonus or none", () => {
    if (isBonusOption(r.bonus)) {
      expect(r.bonus.intensity).toBe("easy");
      expect(r.bonus.loadVector.muscular_lower).toBeLessThanOrEqual(3);
    }
  });
});

describe("engine — spec §99-2: two easy days, good readiness, VO2 gap", () => {
  it("recommends VO2 when every other stimulus is covered and the legs are fresh", () => {
    const history = [
      session({ date: addDays(T, -9), profile: "run_threshold", kind: "run_threshold" }),
      session({ date: addDays(T, -8), profile: "easy_bike_60", kind: "bike_easy_60" }),
      session({ date: addDays(T, -7), profile: "run_long_90", kind: "run_long_90" }),
      session({ date: addDays(T, -6), profile: "deadlift_crossfit", kind: "crossfit" }),
      session({ date: addDays(T, -5), profile: "upper_strength", kind: "strength_upper" }),
      // T-4: rest day
      session({ date: addDays(T, -3), profile: "olympic_technique", kind: "olympic_technique" }),
      session({ date: addDays(T, -2), profile: "gymnastics_skill", kind: "gymnastics_skill" }),
      session({ date: addDays(T, -1), profile: "easy_bike_60", kind: "bike_easy_60" }),
    ];
    const r = runEngine(scenario({ today: T, history }));
    expect(r.primary.kind).toBe("run_vo2");
    expect(vetoedKinds(r)).not.toContain("run_vo2");
    expect(
      r.trace.candidates
        .find((c) => c.kind === "run_vo2")
        ?.outcomes.some((o) => o.ruleId === "STALENESS"),
    ).toBe(true);
  });

  it("keeps VO2 among the top options in a balanced fortnight where the week still has other holes", () => {
    const history = [
      session({ date: addDays(T, -13), profile: "heavy_squat_wallballs", kind: "crossfit" }),
      session({ date: addDays(T, -12), profile: "olympic_technique", kind: "olympic_technique" }),
      session({ date: addDays(T, -11), profile: "run_long_90", kind: "run_long_90" }),
      session({ date: addDays(T, -10), profile: "deadlift_crossfit", kind: "crossfit" }),
      session({ date: addDays(T, -9), profile: "easy_bike_60", kind: "bike_easy_60" }),
      session({ date: addDays(T, -8), profile: "upper_strength", kind: "strength_upper" }),
      session({ date: addDays(T, -7), profile: "gymnastics_skill", kind: "gymnastics_skill" }),
      session({ date: addDays(T, -6), profile: "deadlift_crossfit", kind: "crossfit" }),
      session({ date: addDays(T, -5), profile: "upper_strength", kind: "strength_upper" }),
      session({ date: addDays(T, -4), profile: "heavy_squat_wallballs", kind: "crossfit" }),
      session({ date: addDays(T, -3), profile: "easy_bike_60", kind: "bike_easy_60" }),
      session({ date: addDays(T, -2), profile: "easy_bike_60", kind: "bike_easy_60" }),
      session({ date: addDays(T, -1), profile: "mobility", kind: "mobility_20", type: "mobility" }),
    ];
    const r = runEngine(scenario({ today: T, history }));
    expect(vetoedKinds(r)).not.toContain("run_vo2");
    const order = r.trace.candidates.map((c) => c.kind);
    expect(order.indexOf("run_vo2")).toBeLessThan(4);
    const scores = Object.fromEntries(r.trace.candidates.map((c) => [c.kind, c.score]));
    expect(scores.run_vo2).toBeGreaterThan(scores.run_easy_60 ?? -99);
    expect(scores.run_vo2).toBeGreaterThan(scores.rest ?? -99);
  });
});

describe("engine — spec §99-3: 'I want to run' with acceptable impact", () => {
  const history = [
    ...typicalHistory(T).filter((s) => s.date < addDays(T, -3)),
    session({ date: addDays(T, -2), profile: "upper_strength", kind: "strength_upper" }),
    session({ date: addDays(T, -1), profile: "easy_bike_60", kind: "bike_easy_60" }),
  ];
  const r = runEngine(
    scenario({
      today: T,
      history,
      planned: [plannedFree({ date: T, kind: "strength_lower" })],
      intents: [{ kind: "want_run" }],
    }),
  );

  it("turns the day into a run and reschedules the planned strength", () => {
    expect(r.primary.modality).toBe("running");
    expect(ruleIds(r)).toContain("INTENT_RESPECT");
    expect(r.reschedules).toHaveLength(1);
    expect(r.reschedules[0]?.toDate).not.toBeNull();
    expect(ruleIds(r)).toContain("RESCHEDULE_SUGGESTED");
  });
});

describe("engine — spec §99-4: hard run wanted, impact high + recovery poor", () => {
  const history = [
    ...typicalHistory(T).filter((s) => s.date < addDays(T, -3)),
    session({ date: addDays(T, -3), profile: "du_boxjump_metcon", kind: "crossfit" }),
    session({ date: addDays(T, -2), profile: "run_intervals", kind: "run_vo2" }),
    session({ date: addDays(T, -1), profile: "easy_run_45", kind: "run_easy_45" }),
  ];
  const r = runEngine(
    scenario({
      today: T,
      history,
      readiness: {
        band: "poor",
        hasDeclared: true,
        hasMeasured: true,
        signals: ["rhr_high", "sleep_short"],
      },
      intents: [{ kind: "want_run", intensity: "hard" }],
    }),
  );

  it("declines with an alternative instead of approving blindly", () => {
    expect(r.primary.intensity).not.toBe("hard");
    expect(ruleIds(r)).toContain("INTENT_DECLINED_WITH_ALTERNATIVE");
    expect(vetoedKinds(r)).toContain("run_vo2");
    expect(r.explanation).toMatch(/Mauvaise idée|récupération|impact/i);
  });
});

describe("engine — spec §33: 'gros Hyrox ce soir' after three big leg stimuli", () => {
  const mon = addDays(T, -3); // Monday
  const history = [
    ...typicalHistory(T).filter((s) => s.date < mon),
    session({ date: mon, profile: "heavy_squat_wallballs", kind: "crossfit" }),
    session({ date: addDays(mon, 1), profile: "run_intervals", kind: "run_vo2" }),
    session({ date: addDays(mon, 2), profile: "deadlift_crossfit", kind: "crossfit" }),
  ];
  const r = runEngine(
    scenario({
      today: T,
      hour: 17,
      history,
      readiness: {
        band: "poor",
        hasDeclared: true,
        hasMeasured: false,
        signals: ["energy_low", "soreness"],
      },
      intents: [{ kind: "want_hyrox", intensity: "hard" }],
    }),
  );

  it("refuses the hard Hyrox but keeps the spirit", () => {
    expect(vetoedKinds(r)).toContain("hyrox_hard");
    expect(r.primary.family === "hyrox" || r.primary.intensity === "easy").toBe(true);
    expect(r.primary.intensity).not.toBe("hard");
    expect(ruleIds(r)).toContain("INTENT_DECLINED_WITH_ALTERNATIVE");
    expect(r.explanation).toMatch(/stimuli jambes|Mauvaise idée/i);
  });
});

describe("engine — hard budget with lookahead", () => {
  it("does not propose VO2 on Thursday when 2 hard are done and a class is fixed Saturday", () => {
    const history = [
      ...typicalHistory(T).filter((s) => s.date < addDays(T, -5)),
      session({ date: addDays(T, -4), profile: "heavy_squat_wallballs", kind: "crossfit" }),
      session({ date: addDays(T, -3), profile: "easy_bike_60", kind: "bike_easy_60" }),
      session({ date: addDays(T, -2), profile: "run_intervals", kind: "run_vo2" }),
      session({ date: addDays(T, -1), profile: "easy_bike_60", kind: "bike_easy_60" }),
    ];
    const r = runEngine(
      scenario({ today: T, history, planned: [fixedClass({ date: addDays(T, 2) })] }),
    );
    expect(r.primary.intensity).not.toBe("hard");
    expect(vetoedKinds(r)).toContain("run_vo2");
    expect(r.trace.derived.hardBudgetRemaining).toBeLessThanOrEqual(0);
  });

  it("never vetoes the fixed class itself and attaches scale advice when the budget is spent", () => {
    const history = [
      session({ date: addDays(T, -3), profile: "heavy_squat_wallballs", kind: "crossfit" }),
      session({ date: addDays(T, -2), profile: "run_intervals", kind: "run_vo2" }),
      session({ date: addDays(T, -1), profile: "du_boxjump_metcon", kind: "crossfit" }),
    ];
    const r = runEngine(
      scenario({
        today: T,
        history,
        planned: [fixedClass({ date: T, profile: "front_squat_class" })],
      }),
    );
    expect(r.primary.kind).toBe("crossfit_as_programmed");
    expect(r.advice.some((a) => a.code === "SCALE_ADVICE")).toBe(true);
  });
});

describe("engine — fixed class with unknown WOD", () => {
  it("class tomorrow unknown → no heavy lower today", () => {
    const r = runEngine(
      scenario({
        today: T,
        history: typicalHistory(T).filter((s) => s.date < addDays(T, -2)),
        planned: [fixedClass({ date: addDays(T, 1), profile: null })],
      }),
    );
    expect(r.primary.kind).not.toBe("strength_lower");
    expect(r.trace.derived.tomorrowDemandSource).toBe("prior");
    const lower = r.trace.candidates.find((c) => c.kind === "strength_lower");
    expect(
      lower?.outcomes.some(
        (o) => o.ruleId === "FIXED_CLASS_RESERVE" || o.ruleId === "TOMORROW_HEAVY_CONFLICT",
      ),
    ).toBe(true);
  });

  it("class tonight unknown + vo2 gap → VO2 not primary, class is primary, asks for the WOD", () => {
    const r = runEngine(
      scenario({
        today: T,
        history: typicalHistory(T).filter(
          (s) => !s.kind?.includes("vo2") && s.date < addDays(T, -2),
        ),
        planned: [fixedClass({ date: T, profile: null })],
      }),
    );
    expect(r.primary.kind).toBe("crossfit_generic");
    expect(r.askFor).toContain("wod");
    expect(r.confidence.level).not.toBe("HIGH");
  });

  it("parse confidence 0.4 → prior used and wod_review requested", () => {
    const r = runEngine(
      scenario({
        today: T,
        history: typicalHistory(T),
        planned: [
          fixedClass({
            date: T,
            profile: "front_squat_class",
            wodStatus: "needs_review",
            wodConfidence: 0.4,
          }),
        ],
      }),
    );
    expect(r.primary.kind).toBe("crossfit_generic");
    expect(r.askFor).toContain("wod_review");
  });
});

describe("engine — bonus gate", () => {
  it("Monday fresh + class tonight → no bonus", () => {
    const monday = "2026-09-28";
    const r = runEngine(
      scenario({
        today: monday,
        history: typicalHistory(monday).filter((s) => s.date < addDays(monday, -2)),
        planned: [fixedClass({ date: monday, profile: "heavy_squat_wallballs" })],
      }),
    );
    expect(r.primary.fixed).toBe(true);
    expect(r.bonus.kind).toBe("none");
  });

  it("late week with a big aerobic gap and one free day left → easy bonus", () => {
    const sat = "2026-10-03";
    const history = [
      session({ date: addDays(sat, -6), profile: "run_long_90", kind: "run_long_90" }),
      session({ date: addDays(sat, -5), profile: "upper_strength", kind: "strength_upper" }),
      session({
        date: addDays(sat, -4),
        profile: "heavy_squat_wallballs",
        kind: "crossfit",
        rpe: 7,
      }),
      session({ date: addDays(sat, -3), profile: "olympic_technique", kind: "olympic_technique" }),
      session({ date: addDays(sat, -2), profile: "gymnastics_skill", kind: "gymnastics_skill" }),
      session({
        date: addDays(sat, -1),
        profile: "mobility",
        kind: "mobility_20",
        type: "mobility",
      }),
    ];
    const r = runEngine(
      scenario({
        today: sat,
        history,
        availability: {
          windows: [
            { startMinute: 9 * 60, endMinute: 12 * 60 },
            { startMinute: 17 * 60, endMinute: 19 * 60 },
          ],
          totalMinutes: 300,
        },
      }),
    );
    expect(r.primary.durationMin).toBeLessThanOrEqual(90);
    expect(isBonusOption(r.bonus)).toBe(true);
    if (isBonusOption(r.bonus)) {
      expect(r.bonus.intensity).toBe("easy");
      expect(r.bonus.expectedCredits.aerobic_easy ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("engine — safety rules", () => {
  it("knee pain 6 → no squat-heavy candidates; pain 8 sudden+persistent → medical advice", () => {
    const r = runEngine(
      scenario({
        today: T,
        history: typicalHistory(T),
        pain: [
          {
            location: "knee",
            intensity: 6,
            movementSpecific: true,
            movements: ["squat"],
            sudden: false,
            persistent: true,
            reportedAt: `${T}T07:00:00Z`,
          },
        ],
      }),
    );
    for (const k of kinds(r)) {
      const p = profileOfKind(k);
      expect(p.loadVector.muscular_lower).toBeLessThan(6);
    }
    expect(ruleIds(r)).toContain("PAIN_ACTIVE");
    const r2 = runEngine(
      scenario({
        today: T,
        history: typicalHistory(T),
        pain: [
          {
            location: "lower_back",
            intensity: 8,
            movementSpecific: false,
            movements: [],
            sudden: true,
            persistent: true,
            reportedAt: `${T}T07:00:00Z`,
          },
        ],
      }),
    );
    expect(r2.advice.some((a) => a.code === "MEDICAL_ADVICE")).toBe(true);
  });

  it("baseline phase → at most 2 hard proposed and no double, confidence ≤ MEDIUM", () => {
    const r = runEngine(
      scenario({
        today: T,
        history: typicalHistory(T).filter((s) => s.date < addDays(T, -3)),
        baselinePhase: true,
      }),
    );
    expect(r.confidence.level).not.toBe("HIGH");
    expect(r.bonus.kind).toBe("none");
  });

  it("deload → no VO2, tests or benchmarks", () => {
    const r = runEngine(
      scenario({
        today: T,
        history: typicalHistory(T).filter((s) => s.date < addDays(T, -3)),
        deload: { active: true, reason: "test" },
        intents: [{ kind: "feel_hot" }],
      }),
    );
    expect(vetoedKinds(r)).toContain("run_vo2");
    expect(r.primary.kind).not.toBe("run_vo2");
    expect(r.primary.isTest).not.toBe(true);
  });

  it("six consecutive training days → hard vetoed and recovery promoted", () => {
    const history = [0, 1, 2, 3, 4, 5].map((i) =>
      session({
        date: addDays(T, -1 - i),
        profile: i % 2 ? "easy_bike_60" : "upper_strength",
        kind: i % 2 ? "bike_easy_60" : "strength_upper",
      }),
    );
    const r = runEngine(scenario({ today: T, history }));
    expect(ruleIds(r)).toContain("WEEKLY_RECOVERY_DAY");
    expect(r.primary.intensity).toBe("easy");
    expect(r.primary.durationMin).toBeLessThanOrEqual(45);
  });

  it("primary already done today → only easy/recovery suggestions", () => {
    const r = runEngine(
      scenario({
        today: T,
        hour: 14,
        history: [
          ...typicalHistory(T),
          session({ date: T, profile: "upper_strength", kind: "strength_upper", hour: 10 }),
        ],
      }),
    );
    expect(r.primaryDone).toBe(true);
    expect(r.primary.kind).toBe("strength_upper");
    for (const a of r.alternatives) expect(a.intensity).toBe("easy");
  });

  it("availability shorter than a session → shorter variant or veto", () => {
    const r = runEngine(
      scenario({
        today: T,
        history: typicalHistory(T),
        availability: {
          windows: [{ startMinute: 7 * 60, endMinute: 7 * 60 + 40 }],
          totalMinutes: 40,
        },
      }),
    );
    expect(r.primary.durationMin).toBeLessThanOrEqual(40);
    for (const a of r.alternatives) expect(a.durationMin).toBeLessThanOrEqual(40);
  });
});

describe("engine — intents", () => {
  it("'je vais au CrossFit' without a class asks for the WOD", () => {
    const r = runEngine(
      scenario({ today: T, history: typicalHistory(T), intents: [{ kind: "going_crossfit" }] }),
    );
    expect(r.primary.kind).toBe("crossfit_generic");
    expect(r.askFor).toContain("wod");
  });
  it("'j'ai la flemme' gives low-friction options or rest", () => {
    const r = runEngine(
      scenario({ today: T, history: typicalHistory(T), intents: [{ kind: "lazy" }] }),
    );
    expect(r.primary.intensity).toBe("easy");
    expect(r.primary.durationMin).toBeLessThanOrEqual(45);
  });
  it("'repos' is respected", () => {
    const r = runEngine(
      scenario({ today: T, history: typicalHistory(T), intents: [{ kind: "rest" }] }),
    );
    expect(r.primary.kind).toBe("rest");
  });
});

describe("engine — determinism, projection, placement", () => {
  it("same input → identical output", () => {
    const input = scenario({
      today: T,
      history: typicalHistory(T),
      planned: [fixedClass({ date: addDays(T, 1), profile: null })],
    });
    expect(runEngine(input)).toEqual(runEngine(input));
  });

  it("projectWeek never proposes two hard days in a row", () => {
    const days = projectWeek(scenario({ today: T, history: typicalHistory(T) }), 7);
    expect(days).toHaveLength(7);
    for (let i = 1; i < days.length; i++) {
      const prev = days[i - 1]!;
      const cur = days[i]!;
      if (prev.primary.intensity === "hard" && !cur.primary.fixed)
        expect(cur.primary.intensity).not.toBe("hard");
    }
    expect(days.filter((d) => d.primary.intensity === "hard").length).toBeLessThanOrEqual(3);
  });

  it("checkPlacement warns about Heavy Legs the day before a squat class", () => {
    const input = scenario({
      today: T,
      history: typicalHistory(T).filter((s) => s.date < addDays(T, -2)),
      planned: [fixedClass({ date: addDays(T, 2), profile: "front_squat_class" })],
    });
    const v = checkPlacement(
      input,
      { ...profileOfKind("strength_lower"), kind: "strength_lower", title: "Heavy Legs" },
      addDays(T, 1),
    );
    expect(["warn", "veto"]).toContain(v.verdict);
    expect(
      v.outcomes.some(
        (o) => o.ruleId === "TOMORROW_HEAVY_CONFLICT" || o.ruleId === "HIGH_LOWER_BODY_FATIGUE",
      ),
    ).toBe(true);
    const ok = checkPlacement(
      input,
      { ...profileOfKind("mobility_20"), kind: "mobility_20", title: "Mobilité" },
      addDays(T, 1),
    );
    expect(ok.verdict).toBe("ok");
  });
});
