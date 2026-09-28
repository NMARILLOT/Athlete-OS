import { EXERCISE_CATALOG } from "./catalog";
import type { ExerciseDef, ResolvedExercise } from "./types";

/**
 * Normalise a free-text movement name for alias lookup:
 * lowercase, strip accents/punctuation, collapse whitespace, drop common noise tokens
 * ("rx", "@", weights like "60kg", "24/20", numbers), and singularise.
 */
export function normalizeMovementName(input: string): string {
  const base = input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, "'")
    .replace(/&/g, " and ")
    .replace(/-/g, " ")
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = base
    .split(" ")
    .filter((t) => t.length > 0)
    .filter((t) => !NOISE_TOKENS.has(t))
    .filter((t) => !/^\d+([.,]\d+)?(kg|lb|lbs|m|km|cal|cals|s|sec|min|in|inch|")?$/.test(t))
    .filter((t) => !/^\d+\/\d+$/.test(t))
    .filter((t) => !UNIT_TOKENS.has(t));
  return tokens.join(" ").replace(/\s+/g, " ").trim();
}

const UNIT_TOKENS = new Set([
  "kg",
  "kgs",
  "lb",
  "lbs",
  "m",
  "km",
  "cal",
  "cals",
  "calorie",
  "calories",
  "rep",
  "reps",
  "sec",
  "secs",
  "min",
  "mins",
  "meter",
  "meters",
  "metre",
  "metres",
  "in",
  "inch",
  "inches",
  "pood",
]);

/** Equipment qualifiers: when the input names one and a candidate alias names a different one, penalise. */
const EQUIPMENT_QUALIFIERS: Record<string, string> = {
  dumbbell: "dumbbell",
  db: "dumbbell",
  haltere: "dumbbell",
  kettlebell: "kettlebell",
  kb: "kettlebell",
  barbell: "barbell",
  bb: "barbell",
  ring: "ring",
  rings: "ring",
  sandbag: "sandbag",
};

function equipmentOf(tokens: Iterable<string>): string | null {
  for (const t of tokens) {
    const q = EQUIPMENT_QUALIFIERS[t];
    if (q) return q;
  }
  return null;
}

const NOISE_TOKENS = new Set([
  "rx",
  "rx'd",
  "scaled",
  "x",
  "of",
  "the",
  "a",
  "an",
  "de",
  "des",
  "le",
  "la",
  "les",
  "at",
  "with",
  "avec",
  "each",
  "alternating",
  "alt",
  "unbroken",
  "ub",
  "heavy",
  "light",
  "moderate",
  "lourd",
  "leger",
  "synchro",
  "sync",
]);

interface AliasIndex {
  exact: Map<string, ExerciseDef>;
  tokenSets: Array<{ exercise: ExerciseDef; tokens: Set<string>; alias: string }>;
}

function singularise(s: string): string {
  return s
    .split(" ")
    .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t))
    .join(" ");
}

function buildIndex(catalog: readonly ExerciseDef[]): AliasIndex {
  const exact = new Map<string, ExerciseDef>();
  const tokenSets: AliasIndex["tokenSets"] = [];
  for (const ex of catalog) {
    const names = new Set<string>([ex.name, ex.id.replace(/_/g, " "), ...ex.aliases]);
    for (const raw of names) {
      const n = normalizeMovementName(raw);
      if (!n) continue;
      if (!exact.has(n)) exact.set(n, ex);
      const sg = singularise(n);
      if (!exact.has(sg)) exact.set(sg, ex);
      tokenSets.push({ exercise: ex, tokens: new Set(sg.split(" ")), alias: sg });
    }
  }
  return { exact, tokenSets };
}

let defaultIndex: AliasIndex | null = null;

function getIndex(catalog?: readonly ExerciseDef[]): AliasIndex {
  if (catalog) return buildIndex(catalog);
  if (!defaultIndex) defaultIndex = buildIndex(EXERCISE_CATALOG);
  return defaultIndex;
}

/**
 * Resolve a free-text movement name to a catalog exercise.
 * Returns `null` when nothing is close enough (the caller keeps the raw text and lowers confidence).
 */
export function resolveExercise(
  input: string,
  options: { catalog?: readonly ExerciseDef[]; minConfidence?: number } = {},
): ResolvedExercise | null {
  const index = getIndex(options.catalog);
  const minConfidence = options.minConfidence ?? 0.6;
  const normalized = normalizeMovementName(input);
  if (!normalized) return null;

  const exactHit = index.exact.get(normalized);
  if (exactHit) return { exercise: exactHit, confidence: 1, method: "exact" };

  const singular = singularise(normalized);
  const singularHit = index.exact.get(singular);
  if (singularHit) return { exercise: singularHit, confidence: 0.95, method: "singular" };

  // Fuzzy: token overlap (Dice coefficient) with a bonus for the alias being a full sub-phrase.
  const inputTokens = new Set(singular.split(" "));
  const inputEquipment = equipmentOf(inputTokens);
  let best: { exercise: ExerciseDef; score: number } | null = null;
  for (const entry of index.tokenSets) {
    let common = 0;
    for (const t of entry.tokens) if (inputTokens.has(t)) common++;
    if (common === 0) continue;
    const dice = (2 * common) / (entry.tokens.size + inputTokens.size);
    const subPhrase = singular.includes(entry.alias) || entry.alias.includes(singular);
    // "dumbbell hang power clean" must not resolve to the barbell hang power clean.
    const aliasEquipment = equipmentOf(entry.tokens);
    const equipmentMismatch =
      inputEquipment !== null && aliasEquipment !== inputEquipment && inputEquipment !== "barbell";
    const score = Math.min(1, dice + (subPhrase ? 0.15 : 0) - (equipmentMismatch ? 0.35 : 0));
    if (!best || score > best.score) best = { exercise: entry.exercise, score };
  }
  if (best && best.score >= minConfidence) {
    return {
      exercise: best.exercise,
      confidence: Math.round(best.score * 100) / 100,
      method: "fuzzy",
    };
  }
  return null;
}

/** Convenience for tests and seeds: all aliases flattened as `[alias, exerciseId]`. */
export function listAliasPairs(
  catalog: readonly ExerciseDef[] = EXERCISE_CATALOG,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const ex of catalog) {
    for (const a of new Set([ex.name.toLowerCase(), ...ex.aliases])) out.push([a, ex.id]);
  }
  return out;
}
