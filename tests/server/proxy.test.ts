import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

/**
 * src/proxy.ts is exercised with a stand-in for @supabase/ssr's server client that reproduces the
 * one contract the proxy relies on: `auth.signOut()` clears the session cookies through the
 * `setAll` callback the proxy passed in (so the cleared cookies land on `response`).
 */
type FakeUser = { id: string; email?: string } | null;

const state: { user: FakeUser; signOutCalls: number } = { user: null, signOutCalls: 0 };

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _anon: string,
    options: {
      cookies: {
        getAll: () => { name: string; value: string }[];
        setAll: (
          cookies: { name: string; value: string; options?: Record<string, unknown> }[],
        ) => void;
      };
    },
  ) => ({
    auth: {
      getUser: async () => ({ data: { user: state.user } }),
      signOut: async () => {
        state.signOutCalls += 1;
        options.cookies.setAll([
          { name: "sb-test-auth-token", value: "", options: { maxAge: 0, path: "/" } },
        ]);
        state.user = null;
        return { error: null };
      },
    },
  }),
}));

const ORIGIN = "http://localhost:3000";

function request(path: string, cookie = "sb-test-auth-token=session") {
  return new NextRequest(new URL(path, ORIGIN), { headers: { cookie } });
}

async function run(path: string) {
  const { proxy } = await import("@/proxy");
  return proxy(request(path));
}

beforeEach(() => {
  vi.resetModules();
  state.user = null;
  state.signOutCalls = 0;
  vi.stubEnv("AUTH_MODE", "supabase");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
  vi.stubEnv("ALLOWED_EMAILS", "nico@example.test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("proxy — signed-in visit to /login honours ?next= as a path", () => {
  beforeEach(() => {
    state.user = { id: "u1", email: "nico@example.test" };
  });

  it("keeps a query string instead of percent-encoding it into the pathname", async () => {
    const res = await run("/login?next=%2Finbox%2Fnew%3Ffor%3D2026-09-28");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/inbox/new?for=2026-09-28`);
  });

  it("keeps a hash", async () => {
    const res = await run("/login?next=%2Ftoday%23top");
    expect(res.headers.get("location")).toBe(`${ORIGIN}/today#top`);
  });

  it("falls back to /today and never leaves the origin", async () => {
    expect((await run("/login")).headers.get("location")).toBe(`${ORIGIN}/today`);
    expect((await run("/login?next=https%3A%2F%2Fevil.example")).headers.get("location")).toBe(
      `${ORIGIN}/today`,
    );
    expect((await run("/login?next=%2F%2Fevil.example")).headers.get("location")).toBe(
      `${ORIGIN}/today`,
    );
  });

  it("does not sign out an allow-listed account (case-insensitive)", async () => {
    state.user = { id: "u1", email: "Nico@Example.test" };
    const res = await run("/today");
    expect(res.status).toBe(200);
    expect(state.signOutCalls).toBe(0);
  });
});

describe("proxy — unauthenticated navigation", () => {
  it("redirects to /login with the full path (query included) in ?next=", async () => {
    const res = await run("/inbox/new?for=2026-09-28");
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/inbox/new?for=2026-09-28");
  });

  it("lets /login, /offline and /api/* through", async () => {
    expect((await run("/login")).status).toBe(200);
    expect((await run("/offline")).status).toBe(200);
    expect((await run("/api/strength/sync")).status).toBe(200);
  });
});

describe("proxy — an account outside ALLOWED_EMAILS is signed out, not trapped", () => {
  beforeEach(() => {
    state.user = { id: "u2", email: "intruder@example.test" };
  });

  it("signs out and redirects to /login?reason=forbidden with the cleared cookies", async () => {
    const res = await run("/today");
    expect(state.signOutCalls).toBe(1);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/login?reason=forbidden`);
    const cleared = res.cookies.get("sb-test-auth-token");
    expect(cleared?.value).toBe("");
    expect(cleared?.maxAge).toBe(0);
  });

  it("explains on a direct visit to /login too, without bouncing to ?next=", async () => {
    const res = await run("/login?next=%2Fcalendar");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/login?reason=forbidden`);
  });

  it("renders the explained login form (no redirect loop) while the forbidden session is still present", async () => {
    const res = await run("/login?reason=forbidden");
    expect(state.signOutCalls).toBe(1);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get("sb-test-auth-token")?.value).toBe("");
  });

  it("leaves Route Handlers to answer 403 themselves (no HTML redirect for a fetch)", async () => {
    const res = await run("/api/strength/sync");
    expect(res.status).toBe(200);
    expect(state.signOutCalls).toBe(0);
  });

  it("treats a session without an email as not allowed", async () => {
    state.user = { id: "u3" };
    const res = await run("/today");
    expect(res.headers.get("location")).toBe(`${ORIGIN}/login?reason=forbidden`);
  });

  it("admits everyone when the allow-list is empty (development; production refuses to boot)", async () => {
    vi.stubEnv("ALLOWED_EMAILS", " , ");
    const res = await run("/today");
    expect(res.status).toBe(200);
    expect(state.signOutCalls).toBe(0);
  });
});

describe("proxy — disabled modes", () => {
  it("enforces nothing in AUTH_MODE=local", async () => {
    vi.stubEnv("AUTH_MODE", "local");
    expect((await run("/today")).status).toBe(200);
  });

  it("enforces nothing when Supabase is not configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    expect((await run("/today")).status).toBe(200);
  });
});
