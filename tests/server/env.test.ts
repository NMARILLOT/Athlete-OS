import { readFileSync } from "node:fs";
import { parse as parseDotenv } from "dotenv";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

/**
 * `env()` parses process.env once per module instance and decides "production" at import time,
 * so every case resets the module registry and stubs the variables before importing.
 */
const EXAMPLE = parseDotenv(readFileSync(new URL("../../.env.example", import.meta.url), "utf8"));

const FIXED_KEYS = [
  "NODE_ENV",
  "VERCEL",
  "AUTH_MODE",
  "DATABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "ALLOWED_EMAILS",
  "AI_PROVIDER",
  "ANTHROPIC_API_KEY",
  "LOCAL_USER_EMAIL",
  "AI_DAILY_CAP_PARSE_WOD",
] as const;

/** Every variable a case may touch: the fixed set plus everything .env.example declares. */
const KEYS: readonly string[] = [...new Set([...FIXED_KEYS, ...Object.keys(EXAMPLE)])];

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else vi.stubEnv(k, v);
  }
  vi.resetModules();
});

async function loadEnv(vars: Record<string, string | undefined>) {
  vi.resetModules();
  for (const k of KEYS) {
    const v = vars[k];
    if (v === undefined) delete process.env[k];
    else vi.stubEnv(k, v);
  }
  return import("@/server/env");
}

const PROD_SUPABASE = {
  NODE_ENV: "production",
  AUTH_MODE: "supabase",
  DATABASE_URL: "postgres://user:pw@db.example.test:6543/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  AI_PROVIDER: "mock",
};

describe("server env — ALLOWED_EMAILS fails closed in production", () => {
  it("refuses to boot in production (supabase mode) when ALLOWED_EMAILS is unset", async () => {
    const mod = await loadEnv(PROD_SUPABASE);
    expect(() => mod.env()).toThrow(/ALLOWED_EMAILS/);
  });

  it('refuses an allow-list that parses to zero addresses ("", "," or blanks)', async () => {
    const blank = await loadEnv({ ...PROD_SUPABASE, ALLOWED_EMAILS: "" });
    expect(() => blank.env()).toThrow(/ALLOWED_EMAILS/);
    const commas = await loadEnv({ ...PROD_SUPABASE, ALLOWED_EMAILS: " , ,, " });
    expect(() => commas.env()).toThrow(/ALLOWED_EMAILS/);
  });

  it("boots with at least one address and normalises the list", async () => {
    const mod = await loadEnv({
      ...PROD_SUPABASE,
      ALLOWED_EMAILS: " Nico@Example.test, b@y.test ",
    });
    expect(() => mod.env()).not.toThrow();
    expect(mod.allowedEmails()).toEqual(["nico@example.test", "b@y.test"]);
    expect(mod.isProductionRuntime()).toBe(true);
  });

  it("treats VERCEL as production too", async () => {
    const mod = await loadEnv({ ...PROD_SUPABASE, NODE_ENV: "development", VERCEL: "1" });
    expect(() => mod.env()).toThrow(/ALLOWED_EMAILS/);
  });

  it("stays optional outside production (local development against Supabase)", async () => {
    const mod = await loadEnv({
      NODE_ENV: "development",
      AUTH_MODE: "supabase",
      NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      AI_PROVIDER: "mock",
    });
    expect(() => mod.env()).not.toThrow();
    expect(mod.allowedEmails()).toEqual([]);
  });

  it("keeps refusing AUTH_MODE=local in production (existing check unchanged)", async () => {
    const mod = await loadEnv({ ...PROD_SUPABASE, AUTH_MODE: "local", ALLOWED_EMAILS: "a@b.test" });
    expect(() => mod.env()).toThrow(/AUTH_MODE/);
  });
});

describe("server env — blank values (KEY=) behave like unset keys", () => {
  beforeEach(() => {
    // AUTH_MODE=local logs a development warning on first parse; keep the test output quiet.
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("boots from a verbatim copy of .env.example (the README quick start)", async () => {
    // Next's env loader sets `NEXT_PUBLIC_SUPABASE_URL=` to "" — not undefined — which `.url()` rejects.
    expect(EXAMPLE.NEXT_PUBLIC_SUPABASE_URL).toBe("");
    expect(EXAMPLE.AUTH_MODE).toBe("local");
    const mod = await loadEnv({ ...EXAMPLE, NODE_ENV: "development" });
    expect(() => mod.env()).not.toThrow();
    const e = mod.env();
    expect(e.AUTH_MODE).toBe("local");
    expect(e.NEXT_PUBLIC_SUPABASE_URL).toBeUndefined();
    expect(e.ANTHROPIC_API_KEY).toBeUndefined();
    expect(e.AI_PROVIDER).toBe("mock");
    expect(e.AI_DAILY_CAP_PARSE_WOD).toBe(30);
    expect(mod.allowedEmails()).toEqual([]);
  });

  it("applies the defaults when an enum, number or email variable is left blank", async () => {
    const mod = await loadEnv({
      NODE_ENV: "development",
      AUTH_MODE: "local",
      AI_PROVIDER: "",
      AI_DAILY_CAP_PARSE_WOD: "",
      LOCAL_USER_EMAIL: "",
      NEXT_PUBLIC_SUPABASE_URL: "",
    });
    expect(() => mod.env()).not.toThrow();
    const e = mod.env();
    expect(e.AI_PROVIDER).toBe("mock");
    expect(e.AI_DAILY_CAP_PARSE_WOD).toBeUndefined();
    expect(e.LOCAL_USER_EMAIL).toBe("nicolas@local.athlete-os");
    expect(e.NEXT_PUBLIC_SUPABASE_URL).toBeUndefined();
  });

  it("still fails closed in production when the mandatory keys are blank rather than absent", async () => {
    const mod = await loadEnv({
      ...PROD_SUPABASE,
      ALLOWED_EMAILS: "a@b.test",
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
    });
    expect(() => mod.env()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });
});

describe("parseEmailList (shared with the proxy)", () => {
  it("trims, lower-cases and drops empty entries", async () => {
    const mod = await loadEnv({ NODE_ENV: "development", AUTH_MODE: "local" });
    expect(mod.parseEmailList(undefined)).toEqual([]);
    expect(mod.parseEmailList("")).toEqual([]);
    expect(mod.parseEmailList(" , ,, ")).toEqual([]);
    expect(mod.parseEmailList(" A@B.test ,c@d.test")).toEqual(["a@b.test", "c@d.test"]);
  });
});
