import "server-only";
import { isProductionEnv, parseEmailList, parseServerEnv, type Env } from "./env-schema";

/**
 * Server environment, parsed once per process with the rules of ./env-schema.ts (fails closed).
 * Server code reads configuration only through `env()`.
 */
export type { Env };
export { parseEmailList };

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  cached = parseServerEnv(process.env);
  if (cached.AUTH_MODE === "local") {
    console.warn(
      "[athlete-os] AUTH_MODE=local — single local user, no authentication. Development only.",
    );
  }
  return cached;
}

export function isProductionRuntime(): boolean {
  return isProductionEnv(process.env);
}

export function allowedEmails(): string[] {
  return parseEmailList(env().ALLOWED_EMAILS);
}
