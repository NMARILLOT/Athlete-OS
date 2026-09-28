import "server-only";
import { env } from "@/server/env";
import { AnthropicAiProvider } from "./anthropic";
import { MockAiProvider } from "./mock";
import type { AiProvider } from "./types";

export * from "./types";
export { heuristicIntent } from "./mock";

let instance: AiProvider | null = null;

/** Selected by AI_PROVIDER (anthropic | mock). The mock is always available (spec §5 / ADR-004). */
export function aiProvider(): AiProvider {
  if (instance) return instance;
  const e = env();
  instance =
    e.AI_PROVIDER === "anthropic" && e.ANTHROPIC_API_KEY
      ? new AnthropicAiProvider(e.ANTHROPIC_API_KEY)
      : new MockAiProvider();
  return instance;
}
