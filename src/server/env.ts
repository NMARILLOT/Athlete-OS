import "server-only";
import { z } from "zod";

/**
 * Server environment (ARCHITECTURE.md §7, ADR-020/021). Parsed once, fails closed:
 *  - AUTH_MODE defaults to "supabase"; "local" is refused in production or on Vercel.
 *  - DATABASE_URL is mandatory in production (PGlite is dev/test only).
 */
const isProduction = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    VERCEL: z.string().optional(),
    DATABASE_URL: z.string().optional(),
    DIRECT_DATABASE_URL: z.string().optional(),
    AUTH_MODE: z.enum(["supabase", "local"]).default("supabase"),
    NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
    ALLOWED_EMAILS: z.string().optional(),
    AI_PROVIDER: z.enum(["anthropic", "mock"]).default("mock"),
    ANTHROPIC_API_KEY: z.string().optional(),
    AI_MODEL_PARSER: z.string().default("claude-sonnet-5-5"),
    AI_MODEL_COACH: z.string().default("claude-opus-5-5"),
    GARMIN_PROVIDER: z.enum(["mock", "official"]).default("mock"),
    GARMIN_CLIENT_ID: z.string().optional(),
    GARMIN_CLIENT_SECRET: z.string().optional(),
    GARMIN_REDIRECT_URI: z.string().optional(),
    BODYCOMP_PROVIDER: z.enum(["manual", "withings", "garmin"]).default("manual"),
    CRON_SECRET: z.string().optional(),
    INTEGRATION_ENCRYPTION_KEY: z.string().optional(),
    LOCAL_USER_EMAIL: z.string().email().default("nicolas@local.athlete-os"),
    LOCAL_USER_TIMEZONE: z.string().default("Europe/Paris"),
    FLAG_GARMIN: z.string().optional(),
    FLAG_AI_COACH: z.string().optional(),
    FLAG_BODY_COMP: z.string().optional(),
    FLAG_ADVANCED_READINESS: z.string().optional(),
    FLAG_EXPERIMENTAL_METRICS: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_MODE === "local" && isProduction) {
      ctx.addIssue({
        code: "custom",
        path: ["AUTH_MODE"],
        message: "AUTH_MODE=local is refused in production / on Vercel.",
      });
    }
    if (
      env.AUTH_MODE === "supabase" &&
      (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY) &&
      isProduction
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["NEXT_PUBLIC_SUPABASE_URL"],
        message: "Supabase URL and anon key are required in supabase auth mode.",
      });
    }
    if (isProduction && !env.DATABASE_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "DATABASE_URL is mandatory in production.",
      });
    }
    if (env.AI_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["ANTHROPIC_API_KEY"],
        message: "ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic.",
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server environment — ${issues}`);
  }
  cached = parsed.data;
  if (cached.AUTH_MODE === "local") {
    console.warn(
      "[athlete-os] AUTH_MODE=local — single local user, no authentication. Development only.",
    );
  }
  return cached;
}

export function isProductionRuntime(): boolean {
  return isProduction;
}

export function allowedEmails(): string[] {
  return (env().ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}
