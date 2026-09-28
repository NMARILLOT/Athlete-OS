import "server-only";

/**
 * Structured JSON logger with a CLOSED field type (ARCHITECTURE.md §7): only identifiers, counts,
 * durations, rule ids and error codes can be logged — never health values, tokens or free-form objects.
 */
export interface LogFields {
  userId?: string;
  workoutId?: string;
  activityId?: string;
  inboxItemId?: string;
  recommendationId?: string;
  jobId?: string;
  provider?: string;
  kind?: string;
  count?: number;
  durationMs?: number;
  ruleIds?: string[];
  errorCode?: string;
  errorName?: string;
  status?: number | string;
  route?: string;
  date?: string;
  version?: string;
}

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (process.env.NODE_ENV !== "production" || level !== "debug")
    process.stdout.write(`${line}\n`);
}

export const log = {
  debug: (event: string, fields?: LogFields) => emit("debug", event, fields),
  info: (event: string, fields?: LogFields) => emit("info", event, fields),
  warn: (event: string, fields?: LogFields) => emit("warn", event, fields),
  error: (event: string, fields?: LogFields) => emit("error", event, fields),
};

/** Extract a loggable error summary without leaking messages that may contain tokens or PII. */
export function errorFields(err: unknown): Pick<LogFields, "errorName" | "errorCode"> {
  if (err instanceof Error)
    return { errorName: err.name, errorCode: (err as { code?: string }).code };
  return { errorName: typeof err };
}
