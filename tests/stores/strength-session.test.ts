import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// IndexedDB is not available in node: the persist layer reads nothing and writes nowhere.
vi.mock("idb-keyval", () => ({
  get: vi.fn(async () => undefined),
  set: vi.fn(async () => undefined),
  del: vi.fn(async () => undefined),
}));

import {
  bindStrengthSessionOwner,
  strengthSessionOwner,
  useStrengthSession,
  type StrengthBundle,
} from "@/stores/strength-session";

/**
 * Client store contract (ARCHITECTURE §4.2, §4.6): one monotonic `seq` per workout even across a
 * re-seed, and a persisted session/outbox bound to the athlete who created it.
 */
function bundle(workoutId: string, status: StrengthBundle["status"] = "planned"): StrengthBundle {
  return {
    workoutId,
    title: "Lower A",
    date: "2026-09-28",
    templateId: null,
    status,
    startedAt: status === "in_progress" ? "2026-09-28T17:00:00.000Z" : null,
    exercises: [
      {
        id: "ex-1",
        exerciseId: "back_squat",
        name: "Back squat",
        order: 0,
        prescription: {
          sets: 3,
          repMin: 5,
          repMax: 5,
          targetRpeMin: 7,
          targetRpeMax: 8,
          intent: "strength",
          loadSuggestionKg: 100,
          restSec: null,
        },
        incrementKg: 2.5,
        lastExposure: null,
        bestE1rmKg: null,
        alternates: [],
      },
    ],
    sets: [],
  };
}

const noFeedback = { rpe: null, feeling: null, painReported: false, notes: "" } as const;

beforeEach(async () => {
  await bindStrengthSessionOwner(null);
  useStrengthSession.setState({
    session: null,
    outbox: [],
    ownerUserId: null,
    flushing: false,
    lastFlushError: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("strength session store", () => {
  it("continues the seq of a workout after a re-seed instead of restarting at 0", async () => {
    await bindStrengthSessionOwner("user-a");
    const st = useStrengthSession.getState();
    st.startSession(bundle("w1"));
    st.completeSet("ex-1", 5, 100);
    st.finishSession({ rpe: 8, feeling: "good", painReported: false, notes: "" });
    // Offline: the events stay queued while the shell drops the finished session (another workout
    // was opened), then the athlete reopens this workout's cached shell and logs again.
    useStrengthSession.getState().clearSession();
    useStrengthSession.getState().resumeSession(bundle("w1", "in_progress"));
    expect(useStrengthSession.getState().session?.seq).toBe(3);
    useStrengthSession.getState().completeSet("ex-1", 5, 100);
    useStrengthSession.getState().finishSession(noFeedback);
    const seqs = useStrengthSession
      .getState()
      .outbox.filter((e) => e.workoutId === "w1")
      .map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    // A fresh start of another workout also continues after its own queued events only.
    useStrengthSession.getState().clearSession();
    useStrengthSession.getState().startSession(bundle("w2"));
    expect(useStrengthSession.getState().outbox.find((e) => e.workoutId === "w2")?.seq).toBe(1);
  });

  it("binds the snapshot to its owner and drops it when another athlete signs in", async () => {
    await bindStrengthSessionOwner("user-a");
    expect(strengthSessionOwner()).toBe("user-a");
    expect(useStrengthSession.getState().ownerUserId).toBe("user-a");
    useStrengthSession.getState().startSession(bundle("w3"));
    useStrengthSession.getState().completeSet("ex-1", 5, 100);
    expect(useStrengthSession.getState().outbox).toHaveLength(2);

    await bindStrengthSessionOwner("user-a"); // idempotent
    expect(useStrengthSession.getState().outbox).toHaveLength(2);

    await bindStrengthSessionOwner("user-b"); // another account on the same phone
    expect(useStrengthSession.getState().session).toBeNull();
    expect(useStrengthSession.getState().outbox).toEqual([]);
    expect(useStrengthSession.getState().ownerUserId).toBe("user-b");
  });

  it("never posts a queue owned by another account (or while the owner is unknown)", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { events: Array<{ id: string }> };
      return {
        status: 200,
        ok: true,
        json: async () => ({ acknowledged: body.events.map((e) => e.id) }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await bindStrengthSessionOwner("user-a");
    useStrengthSession.getState().startSession(bundle("w4"));
    expect(useStrengthSession.getState().outbox).toHaveLength(1);

    await bindStrengthSessionOwner(null); // outside the app (login screen): owner unknown
    await useStrengthSession.getState().flushOutbox();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useStrengthSession.getState().outbox).toHaveLength(1);

    await bindStrengthSessionOwner("user-a"); // the owner is back
    await useStrengthSession.getState().flushOutbox();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useStrengthSession.getState().outbox).toEqual([]);
  });
});
