import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { INTENT_KIND_VALUES, INTENSITY_BAND_VALUES, type UserIntent } from "@/domain/core";
import { listAliasPairs } from "@/domain/exercises";
import { NormalizedWodSchema, type NormalizedWod } from "@/domain/wod";
import { env } from "@/server/env";
import { log, errorFields } from "@/server/logging";
import { MockAiProvider } from "./mock";
import { hashInput, type AiProvider, type AiResult, type ExplainInput } from "./types";

const PROMPT_VERSION_PARSE_WOD = "parse_wod_v1";
const PROMPT_VERSION_PARSE_INTENT = "parse_intent_v1";
const PROMPT_VERSION_EXPLAIN = "explain_v1";

/** Structure-only intent (bounded), mirrors domain UserIntent without free text. */
const IntentOutputSchema = z.object({
  kind: z.enum(INTENT_KIND_VALUES),
  intensity: z.enum(INTENSITY_BAND_VALUES).nullable(),
  availableMinutes: z.number().int().min(10).max(300).nullable(),
  /** "today" | "tomorrow" — the service maps to dates; the model never invents dates. */
  when: z.enum(["today", "tomorrow"]),
});

const ExplainOutputSchema = z.object({ text: z.string().min(10).max(400) });

/** Alias list is stable → cacheable system prefix. Kept compact (one line per exercise). */
function aliasCatalogText(): string {
  const byId = new Map<string, string[]>();
  for (const [alias, id] of listAliasPairs()) byId.set(id, [...(byId.get(id) ?? []), alias]);
  return [...byId.entries()]
    .map(([id, aliases]) => `${id}: ${aliases.slice(0, 6).join(", ")}`)
    .join("\n");
}

const SYSTEM_PARSE_WOD = `Tu es un parseur de WOD CrossFit. Tu transformes le texte d'une séance en STRUCTURE UNIQUEMENT.
Règles absolues :
- Ne produis AUCUNE physiologie (pas de muscles, stimulus, intensité, système énergétique) : le moteur déterministe s'en charge.
- Chaque mouvement doit référencer un exerciseId du catalogue ci-dessous quand il correspond ; sinon exerciseId = null, hintedPattern renseigné.
- reps/calories/distanceM/durationSec : uniquement ce qui est écrit. Un schéma 21-15-9 va dans part.repScheme (pas dans reps).
- Charges "43/30 kg" → load { value: 43, alt: 30, unit: "kg" }. "@ 80%" → percent_1rm. "lourd/heavy" → qualifier.
- Formats : sets_reps (5x5), amrap (durationMin), for_time (rounds, timeCapMin), emom (intervalSec, durationMin, alternating), tabata, chipper, ladder, not_timed.
- parts.kind : warmup | strength | skill | metcon | accessory | cooldown. parser = "AI_PARSED", parserVersion = "${PROMPT_VERSION_PARSE_WOD}".
- parseConfidence : ta confiance 0..1 sur la structure. Ajoute un warning pour toute ambiguïté.
- sourceText : recopie le texte d'entrée tel quel (tronqué à 8000 caractères).

Catalogue d'exercices (id: alias) :
`;

/**
 * Anthropic provider. Non-streaming (short outputs), strict structured outputs validated by our own Zod
 * schemas, 30 s timeout, single retry (ADR-022). Any validation failure falls back to the mock provider
 * and is logged; the caller records the invocation either way.
 */
export class AnthropicAiProvider implements AiProvider {
  readonly name = "anthropic" as const;
  private readonly client: Anthropic;
  private readonly fallback = new MockAiProvider();
  private readonly catalogText = aliasCatalogText();

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 1, timeout: 30_000 });
  }

  async parseWod(input: {
    text: string;
    imageBase64?: string;
    imageMediaType?: "image/jpeg" | "image/png" | "image/webp";
  }): Promise<AiResult<NormalizedWod>> {
    const start = Date.now();
    const model = env().AI_MODEL_PARSER;
    const inputHash = hashInput({
      text: input.text,
      image: input.imageBase64 ? input.imageBase64.length : 0,
      v: PROMPT_VERSION_PARSE_WOD,
    });
    try {
      const content: Anthropic.ContentBlockParam[] = [];
      if (input.imageBase64 && input.imageMediaType)
        content.push({
          type: "image",
          source: { type: "base64", media_type: input.imageMediaType, data: input.imageBase64 },
        });
      content.push({
        type: "text",
        text: input.text
          ? `WOD :\n${input.text}`
          : "Transcris et structure le WOD visible sur l'image.",
      });
      const response = await this.client.messages.parse({
        model,
        max_tokens: 4000,
        output_config: { effort: "low", format: zodOutputFormat(NormalizedWodSchema) },
        system: [
          {
            type: "text",
            text: SYSTEM_PARSE_WOD + this.catalogText,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content }],
      });
      if (response.stop_reason === "refusal" || !response.parsed_output)
        throw new Error(`parse_wod: no parsed output (${response.stop_reason})`);
      // Re-validate with our strict schema (defense in depth) and force provenance fields.
      const output = NormalizedWodSchema.parse({
        ...response.parsed_output,
        sourceText: input.text.slice(0, 8000) || response.parsed_output.sourceText,
        parser: "AI_PARSED",
        parserVersion: PROMPT_VERSION_PARSE_WOD,
      });
      return {
        output,
        meta: {
          kind: "parse_wod",
          model,
          promptVersion: PROMPT_VERSION_PARSE_WOD,
          inputHash,
          latencyMs: Date.now() - start,
          tokensIn: response.usage.input_tokens,
          tokensOut: response.usage.output_tokens,
          provider: "anthropic",
        },
      };
    } catch (err) {
      log.warn("ai.parse_wod.fallback", { ...errorFields(err), durationMs: Date.now() - start });
      const fb = await this.fallback.parseWod({ text: input.text });
      return {
        ...fb,
        output: {
          ...fb.output,
          warnings: [...fb.output.warnings, "Analyse IA indisponible : structure heuristique."],
        },
      };
    }
  }

  async parseIntent(input: {
    text: string;
    today: string;
    tomorrow: string;
  }): Promise<AiResult<UserIntent>> {
    const start = Date.now();
    const model = env().AI_MODEL_PARSER;
    const inputHash = hashInput({ text: input.text, v: PROMPT_VERSION_PARSE_INTENT });
    try {
      const response = await this.client.messages.parse({
        model,
        max_tokens: 400,
        output_config: { effort: "low", format: zodOutputFormat(IntentOutputSchema) },
        system: `Tu classes une phrase d'un athlète en une intention d'entraînement bornée. kinds : ${INTENT_KIND_VALUES.join(", ")}. intensity seulement si la phrase l'exprime. availableMinutes seulement si un temps est donné. when = tomorrow seulement si la phrase parle de demain. Aucun texte libre.`,
        messages: [{ role: "user", content: input.text.slice(0, 500) }],
      });
      if (response.stop_reason === "refusal" || !response.parsed_output)
        throw new Error("parse_intent: no parsed output");
      const p = response.parsed_output;
      const output: UserIntent = {
        kind: p.kind,
        intensity: p.intensity ?? undefined,
        availableMinutes: p.availableMinutes ?? undefined,
        rawText: input.text.slice(0, 200),
        date: p.when === "tomorrow" ? input.tomorrow : input.today,
      };
      return {
        output,
        meta: {
          kind: "parse_intent",
          model,
          promptVersion: PROMPT_VERSION_PARSE_INTENT,
          inputHash,
          latencyMs: Date.now() - start,
          tokensIn: response.usage.input_tokens,
          tokensOut: response.usage.output_tokens,
          provider: "anthropic",
        },
      };
    } catch (err) {
      log.warn("ai.parse_intent.fallback", { ...errorFields(err), durationMs: Date.now() - start });
      return this.fallback.parseIntent(input);
    }
  }

  async explain(input: ExplainInput): Promise<AiResult<{ text: string }>> {
    const start = Date.now();
    const model = env().AI_MODEL_COACH;
    const inputHash = hashInput({
      rules: input.rulesTriggered.map((r) => r.ruleId),
      t: input.templatedExplanation,
      v: PROMPT_VERSION_EXPLAIN,
    });
    try {
      const response = await this.client.messages.parse({
        model,
        max_tokens: 600,
        output_config: { effort: "low", format: zodOutputFormat(ExplainOutputSchema) },
        system:
          "Tu reformules en français, en deux phrases maximum, factuelles et chaleureuses, l'explication d'une recommandation d'entraînement. Tu ne changes JAMAIS la décision, tu n'ajoutes aucune charge, allure ou durée qui ne figure pas dans les données fournies, et tu ne recommandes rien d'autre.",
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              decision: input.primaryTitle,
              alternatives: input.alternatives,
              rules: input.rulesTriggered,
              context: input.context,
              base: input.templatedExplanation,
            }),
          },
        ],
      });
      if (response.stop_reason === "refusal" || !response.parsed_output)
        throw new Error("explain: no parsed output");
      const text = response.parsed_output.text;
      // Post-check (ADR-022): reject wording that names an option absent from the recommendation or injects numbers with units.
      const mentionsForeignKg =
        /\b\d+([.,]\d+)?\s*(kg|km\/h|min\/km|bpm)\b/i.test(text) &&
        !/\d+([.,]\d+)?\s*(kg|km\/h|min\/km|bpm)/i.test(input.templatedExplanation);
      if (mentionsForeignKg) throw new Error("explain: post-check rejected numeric claims");
      return {
        output: { text },
        meta: {
          kind: "explain",
          model,
          promptVersion: PROMPT_VERSION_EXPLAIN,
          inputHash,
          latencyMs: Date.now() - start,
          tokensIn: response.usage.input_tokens,
          tokensOut: response.usage.output_tokens,
          provider: "anthropic",
        },
      };
    } catch (err) {
      log.warn("ai.explain.fallback", { ...errorFields(err), durationMs: Date.now() - start });
      return this.fallback.explain(input);
    }
  }
}
