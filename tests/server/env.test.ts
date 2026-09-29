import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

/**
 * `env()` parses process.env once per module instance and decides "production" at import time,
 * so every case resets the module registry and stubs the variables before importing.
 */
const KEYS = [
  "NODE_ENV",
  "VERCEL",
  "AUTH_MODE",
  "DATABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "ALLOWED_EMAILS",
  "AI_PROVIDER",
  "ANTHROPIC_API_KEY",
] as const;

const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else vi.stubEnv(k, saved[k]);
  }
  vi.resetModules();
});

async function loadEnv(vars: Partial<Record<(typeof KEYS)[number], string>>) {
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

  it('refuses an allow-list that parses to zero addresses ("," or blanks)', async () => {
    const mod = await loadEnv({ ...PROD_SUPABASE, ALLOWED_EMAILS: " , ,, " });
    expect(() => mod.env()).toThrow(/ALLOWED_EMAILS/);
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
