import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { z } from "zod";
import {
  AppError,
  ForbiddenError,
  NotConfiguredError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from "@/server/errors";
import { httpError } from "@/server/http";

describe("httpError — Route Handler error mapping", () => {
  it("keeps the 401 body for UnauthorizedError", () => {
    expect(httpError(new UnauthorizedError())).toEqual({
      status: 401,
      body: { error: "unauthorized" },
    });
  });

  it("maps the allow-list ForbiddenError to 403 instead of 500", () => {
    const res = httpError(new ForbiddenError("Ce compte n'est pas autorisé."));
    expect(res?.status).toBe(403);
    expect(res?.body).toEqual({ error: "FORBIDDEN", message: "Ce compte n'est pas autorisé." });
  });

  it("maps every other AppError to its own status", () => {
    expect(httpError(new ValidationError("Recharge la page."))?.status).toBe(422);
    expect(httpError(new NotFoundError("Séance"))?.status).toBe(404);
    expect(httpError(new NotConfiguredError("Garmin"))?.status).toBe(501);
    expect(httpError(new AppError("x", "CUSTOM", 409))).toEqual({
      status: 409,
      body: { error: "CUSTOM", message: "x" },
    });
  });

  it("maps a Zod error on the payload to 400 with at most five issues", () => {
    const parsed = z
      .object({ events: z.array(z.string()).min(1) })
      .safeParse({ events: [1, 2, 3, 4, 5, 6, 7] });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const res = httpError(parsed.error);
    expect(res?.status).toBe(400);
    expect(res?.body.error).toBe("invalid");
    expect((res?.body.issues as unknown[]).length).toBeLessThanOrEqual(5);
  });

  it("returns null for unexpected errors so the handler logs and answers 500", () => {
    expect(httpError(new Error("boom"))).toBeNull();
    expect(httpError("string")).toBeNull();
    expect(httpError(null)).toBeNull();
  });
});
