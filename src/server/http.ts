import "server-only";
import { z } from "zod";
import { AppError, UnauthorizedError } from "@/server/errors";

export interface HttpError {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Maps an error thrown inside a Route Handler to the HTTP answer it deserves, or `null` when the
 * error is unexpected (the caller then logs it and answers 500):
 *  - UnauthorizedError → 401 `{ error: "unauthorized" }` (body kept for existing clients);
 *  - any other AppError → its own status (403 allow-list refusal, 404, 422 validation, 501 …);
 *  - ZodError on the request payload → 400 with the first issues.
 */
export function httpError(err: unknown): HttpError | null {
  if (err instanceof UnauthorizedError) return { status: 401, body: { error: "unauthorized" } };
  if (err instanceof AppError)
    return { status: err.status, body: { error: err.code, message: err.message } };
  if (err instanceof z.ZodError)
    return { status: 400, body: { error: "invalid", issues: err.issues.slice(0, 5) } };
  return null;
}
