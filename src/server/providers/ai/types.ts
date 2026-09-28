import type { NormalizedWod } from "@/domain/wod";
import type { UserIntent } from "@/domain/core";

/**
 * AiProvider — Layer B (ADR-004, ADR-022). Every method returns a Zod-validated object or throws.
 * The provider never receives the whole database: callers pass only what the task needs.
 */
export interface AiInvocationMeta {
  kind: "parse_wod" | "parse_intent" | "explain" | "suggest_fun" | "monthly_review";
  model: string;
  promptVersion: string;
  inputHash: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  provider: "anthropic" | "mock";
}

export interface AiResult<T> {
  output: T;
  meta: AiInvocationMeta;
}

export interface ExplainInput {
  rulesTriggered: Array<{ ruleId: string; message: string }>;
  primaryTitle: string;
  alternatives: string[];
  templatedExplanation: string;
  /** Numeric context only (no raw history): e.g. { residualLegs: 5.4, hardDone6d: 2 }. */
  context: Record<string, number | string>;
}

export interface AiProvider {
  readonly name: "anthropic" | "mock";
  /** Free text (pasted WOD) → structure-only NormalizedWod. */
  parseWod(input: {
    text: string;
    imageBase64?: string;
    imageMediaType?: "image/jpeg" | "image/png" | "image/webp";
  }): Promise<AiResult<NormalizedWod>>;
  /** One natural-language sentence → bounded UserIntent. */
  parseIntent(input: {
    text: string;
    today: string;
    tomorrow: string;
  }): Promise<AiResult<UserIntent>>;
  /** Display-only wording for the "POURQUOI ?" screen; the templated explanation is always the fallback. */
  explain(input: ExplainInput): Promise<AiResult<{ text: string }>>;
}

/** Deterministic content hash for idempotent invocations (ai_invocations unique key). */
export function hashInput(parts: Record<string, unknown>): string {
  const s = JSON.stringify(parts, Object.keys(parts).sort());
  let h1 = 0xdeadbeef ^ s.length;
  let h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}
