import "server-only";
import { parseWodText, HEURISTIC_PARSER_VERSION, type NormalizedWod } from "@/domain/wod";
import { type UserIntent, INTENT_KIND_VALUES } from "@/domain/core";
import { hashInput, type AiProvider, type AiResult, type ExplainInput } from "./types";

/**
 * Mock provider: the deterministic heuristic parser + keyword intent parser + templated explanation.
 * This is the AI_PROVIDER=mock path and the fallback when the real provider fails validation.
 */
export class MockAiProvider implements AiProvider {
  readonly name = "mock" as const;

  async parseWod(input: { text: string }): Promise<AiResult<NormalizedWod>> {
    const start = Date.now();
    const output = parseWodText(input.text);
    return {
      output,
      meta: {
        kind: "parse_wod",
        model: "heuristic",
        promptVersion: HEURISTIC_PARSER_VERSION,
        inputHash: hashInput({ text: input.text }),
        latencyMs: Date.now() - start,
        tokensIn: 0,
        tokensOut: 0,
        provider: "mock",
      },
    };
  }

  async parseIntent(input: {
    text: string;
    today: string;
    tomorrow: string;
  }): Promise<AiResult<UserIntent>> {
    const start = Date.now();
    const output = heuristicIntent(input.text, input.today, input.tomorrow);
    return {
      output,
      meta: {
        kind: "parse_intent",
        model: "heuristic",
        promptVersion: "intent_keywords_v1",
        inputHash: hashInput({ text: input.text }),
        latencyMs: Date.now() - start,
        tokensIn: 0,
        tokensOut: 0,
        provider: "mock",
      },
    };
  }

  async explain(input: ExplainInput): Promise<AiResult<{ text: string }>> {
    return {
      output: { text: input.templatedExplanation },
      meta: {
        kind: "explain",
        model: "template",
        promptVersion: "explain_template_v1",
        inputHash: hashInput({ t: input.templatedExplanation }),
        latencyMs: 0,
        tokensIn: 0,
        tokensOut: 0,
        provider: "mock",
      },
    };
  }
}

/** Keyword intent parser (FR/EN). Bounded output by construction. */
export function heuristicIntent(text: string, today: string, tomorrow: string): UserIntent {
  const t = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const date = /\bdemain\b|\btomorrow\b/.test(t) ? tomorrow : today;
  const intensity: UserIntent["intensity"] | undefined =
    /\b(gros|grosse|hard|dur|intense|a fond|max|violent)\b/.test(t)
      ? "hard"
      : /\b(facile|easy|tranquille|cool|leger|legere|z2|zone 2)\b/.test(t)
        ? "easy"
        : undefined;
  const minutes = /(\d{2,3})\s*(min|minutes)/.exec(t);
  const availableMinutes = minutes
    ? Number(minutes[1])
    : /\b(1h30|une heure et demie)\b/.test(t)
      ? 90
      : /\b(1h|une heure)\b/.test(t)
        ? 60
        : /\b2h\b/.test(t)
          ? 120
          : undefined;
  let kind: UserIntent["kind"] = "custom";
  if (/hyrox/.test(t)) kind = "want_hyrox";
  else if (/\b(repos|rest|off|recup(eration)?)\b/.test(t) && !/pas de repos/.test(t)) kind = "rest";
  else if (/\b(pas de jambes|no legs|jambes (sont )?mortes|legs are dead|jambes en vrac)\b/.test(t))
    kind = "no_legs";
  else if (/\b(flemme|lazy|pas envie|fatigue|creve|mort)\b/.test(t)) kind = "lazy";
  else if (/\b(chaud|en forme|motive|feel great|fire|patate)\b/.test(t)) kind = "feel_hot";
  else if (
    /\b(je vais au crossfit|going to crossfit|je vais a la box|au crossfit|cours de crossfit|classe)\b/.test(
      t,
    )
  )
    kind = "going_crossfit";
  else if (/crossfit|wod|metcon/.test(t)) kind = "want_crossfit";
  else if (/\b(courir|course|run|running|trail|footing)\b/.test(t)) kind = "want_run";
  else if (/\b(velo|bike|cycl|rouler)\b/.test(t)) kind = "want_bike";
  else if (/\b(rameur|row|ergo)\b/.test(t)) kind = "want_row";
  else if (/\b(pas de muscu|no strength|pas de force|aucune envie de musculation)\b/.test(t))
    kind = "no_strength";
  else if (/\b(muscu|force|strength|lift|barre|souleve)\b/.test(t)) kind = "want_strength";
  else if (/\b(grosse seance|big session|copains|potes|friends)\b/.test(t))
    kind = "want_big_session";
  else if (/\b(juste bouger|just move|bouger un peu)\b/.test(t)) kind = "just_move";
  else if (/\b(j'?ai du temps|have time|libre)\b/.test(t)) kind = "have_time";
  else if (/\b(surprise|surprends)\b/.test(t)) kind = "surprise";
  if (kind === "custom" && availableMinutes) kind = "have_time";
  if (!INTENT_KIND_VALUES.includes(kind)) kind = "custom";
  return { kind, intensity, availableMinutes, rawText: text.slice(0, 200), date };
}
