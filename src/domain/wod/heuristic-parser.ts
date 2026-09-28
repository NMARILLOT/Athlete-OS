import type { MovementPattern } from "../core";
import { resolveExercise } from "../exercises";
import {
  NormalizedWodSchema,
  type NormalizedWod,
  type WodFormat,
  type WodLoad,
  type WodMovement,
  type WodPart,
  type WodPartKind,
} from "./schema";

/**
 * Deterministic, dependency-free WOD text parser. It is the `AI_PROVIDER=mock` path and the
 * fallback when the AI output fails validation. It handles the common box formats (sets × reps,
 * AMRAP, for time, rounds, EMOM, rep schemes, calories/meters, loads "43/30 kg") and degrades
 * gracefully: unknown lines become unknown movements with lowered confidence.
 */
export const HEURISTIC_PARSER_VERSION = "heuristic_wod_parser_v1" as const;

const HEADER_KIND: Array<[RegExp, WodPartKind]> = [
  [/^(warm[\s-]?up|échauffement|echauffement|prep)\b/i, "warmup"],
  [/^(cool[\s-]?down|retour au calme)\b/i, "cooldown"],
  [/^(strength|force|lifting|haltero|haltéro|weightlifting|barbell)\b/i, "strength"],
  [/^(skill|technique|gymnastics|gym)\b/i, "skill"],
  [/^(accessory|accessoires?|finisher)\b/i, "accessory"],
  [/^(metcon|wod|conditioning|conditioning|workout|cardio)\b/i, "metcon"],
];

const SECTION_LABEL = /^(?:[a-e]\d?[).:-]|part\s*\d+|partie\s*\d+|\d+[).]\s)/i;

interface Draft {
  kind: WodPartKind | null;
  format: WodFormat | null;
  title: string | null;
  durationMin: number | null;
  timeCapMin: number | null;
  rounds: number | null;
  repScheme: number[] | null;
  intervalSec: number | null;
  restSec: number | null;
  sets: number | null;
  reps: number | null;
  movements: WodMovement[];
  notes: string[];
  loadQualifier: WodLoad["qualifier"];
  alternating: boolean;
}

function newDraft(): Draft {
  return {
    kind: null,
    format: null,
    title: null,
    durationMin: null,
    timeCapMin: null,
    rounds: null,
    repScheme: null,
    intervalSec: null,
    restSec: null,
    sets: null,
    reps: null,
    movements: [],
    notes: [],
    loadQualifier: null,
    alternating: false,
  };
}

/** Headers that open a NEW part when movements already exist. */
const NEW_PART_FORMATS = new Set<WodFormat>([
  "amrap",
  "emom",
  "for_time",
  "tabata",
  "chipper",
  "intervals",
]);

const SEPARATOR_LINE =
  /^(?:puis|then|and then|ensuite|après|apres|rest as needed|-+|=+|\*+|_+)\s*:?\s*$/i;

function num(s: string | undefined): number | null {
  if (!s) return null;
  const v = Number(s.replace(",", "."));
  return Number.isFinite(v) ? v : null;
}

/** Parse "43/30 kg", "@ 60kg", "(100/70)", "70%", "24/16", "1.5 pood", "bodyweight". */
function extractLoad(text: string): { load: WodLoad | null; rest: string } {
  let load: WodLoad | null = null;
  let rest = text;
  const pct = /(\d{2,3})\s*%/.exec(rest);
  if (pct) {
    load = { value: Number(pct[1]), unit: "percent_1rm", alt: null, qualifier: null };
    rest = rest.replace(pct[0], " ");
  }
  const kg =
    /(?:@\s*)?\(?\s*(\d+(?:[.,]\d+)?)\s*(?:\/\s*(\d+(?:[.,]\d+)?))?\s*(kg|kgs|kilos?|lbs?|#|pood)\s*\)?/i.exec(
      rest,
    );
  if (!load && kg) {
    const unitRaw = (kg[3] ?? "").toLowerCase();
    const unit: WodLoad["unit"] =
      unitRaw.startsWith("lb") || unitRaw === "#" ? "lb" : unitRaw === "pood" ? "pood" : "kg";
    load = { value: num(kg[1]) ?? 0, unit, alt: num(kg[2]), qualifier: null };
    rest = rest.replace(kg[0], " ");
  }
  if (!load) {
    // "(100/70)", "@ 100/70" or a trailing "43/30" without unit → kg by convention in a French box
    const pair =
      /(?:@|\()\s*(\d{2,3})\s*\/\s*(\d{2,3})\s*\)?/.exec(rest) ??
      /(?:^|\s)(\d{2,3})\s*\/\s*(\d{2,3})(?!\s*(?:cal|kcal|m\b|km|reps?))\s*$/i.exec(rest);
    if (pair) {
      load = { value: Number(pair[1]), unit: "kg", alt: Number(pair[2]), qualifier: null };
      rest = rest.replace(pair[0], " ");
    }
  }
  const qual =
    /\b(heavy|lourd|light|léger|leger|moderate|modéré|modere|build(?:\s+to)?|montée)\b/i.exec(rest);
  if (qual) {
    const q = qual[1]!.toLowerCase();
    const qualifier: WodLoad["qualifier"] =
      q.startsWith("heav") || q === "lourd"
        ? "heavy"
        : q.startsWith("light") || q.startsWith("l")
          ? "light"
          : q.startsWith("build") || q.startsWith("mont")
            ? "build"
            : "moderate";
    load = load ? { ...load, qualifier } : { value: 0, unit: "kg", alt: null, qualifier };
    rest = rest.replace(qual[0], " ");
  }
  return { load, rest: rest.replace(/\s+/g, " ").trim() };
}

function parseMovementLine(line: string, ctx: Draft): WodMovement | null {
  let text = line
    .replace(/^[-•*·]\s*/, "")
    .replace(/^(?:min(?:ute)?\s*)?\d+\s*[).:-]\s+(?=[a-zA-Z0-9éèêàç])/i, "")
    .trim();
  if (!text) return null;
  const modifiers: string[] = [];
  const { load, rest } = extractLoad(text);
  text = rest;

  let reps: number | null = null;
  let calories: number | null = null;
  let caloriesAlt: number | null = null;
  let distanceM: number | null = null;
  let durationSec: number | null = null;
  let sets: number | null = null;
  let repScheme: number[] | null = null;

  // "5x5 back squat" / "back squat 5 x 5" / "3 sets of 8"
  const sx = /(\d+)\s*[x×]\s*(\d+)/i.exec(text);
  if (sx && ctx.format !== "amrap" && ctx.format !== "emom") {
    sets = Number(sx[1]);
    reps = Number(sx[2]);
    text = text.replace(sx[0], " ");
  }
  const setsOf = /(\d+)\s*(?:sets?|séries?|series)\s*(?:of|de|x)?\s*(\d+)/i.exec(text);
  if (setsOf) {
    sets = Number(setsOf[1]);
    reps = Number(setsOf[2]);
    text = text.replace(setsOf[0], " ");
  }
  // rep scheme inside the line: "10-9-8-7 pull-ups"
  const scheme = /\b(\d+(?:\s*-\s*\d+){2,})\b/.exec(text);
  if (scheme) {
    repScheme = scheme[1]!.split(/\s*-\s*/).map(Number);
    text = text.replace(scheme[0], " ");
  }
  // calories: "15 cal", "15/12 cal", "cal 15"
  const cal = /(\d+)\s*(?:\/\s*(\d+))?\s*(?:cal(?:orie)?s?)\b|\bcal(?:orie)?s?\s*(\d+)/i.exec(text);
  if (cal) {
    calories = num(cal[1] ?? cal[3]);
    caloriesAlt = num(cal[2]);
    text = text.replace(cal[0], " cal ");
  }
  // distance: "250 m", "400m", "1 km", "1.5km", "500 meters"
  const dist = /(\d+(?:[.,]\d+)?)\s*(km|kms|m|meters?|mètres?|metres?)\b/i.exec(text);
  if (dist) {
    const v = num(dist[1]) ?? 0;
    distanceM = /^k/i.test(dist[2]!) ? v * 1000 : v;
    text = text.replace(dist[0], " ");
  }
  // duration: "2 min", "30 s", "1:00", "45 sec"
  const dur = /(\d+(?:[.,]\d+)?)\s*(min(?:utes?)?|s|sec(?:onds?)?|secondes?)\b/i.exec(text);
  if (dur && !/^(amrap|emom|every)/i.test(text)) {
    const v = num(dur[1]) ?? 0;
    durationSec = /^m/i.test(dur[2]!) ? v * 60 : v;
    text = text.replace(dur[0], " ");
  }
  // leading reps: "12 wall balls", "x10 pull ups", "10 x pull ups"
  if (reps == null && repScheme == null) {
    const lead = /^(?:x\s*)?(\d+)\s*(?:x|reps?|répétitions?)?\s+(?=[a-zA-Zéèêàç])/i.exec(text);
    if (lead) {
      reps = Number(lead[1]);
      text = text.slice(lead[0].length);
    } else {
      const trail = /\s+[x×]?\s*(\d+)\s*(?:reps?|répétitions?)?$/i.exec(text);
      if (trail) {
        reps = Number(trail[1]);
        text = text.slice(0, trail.index);
      }
    }
  }
  let pace: WodMovement["pace"] = null;
  if (/\b(easy|facile|recovery|récup|recup|z1|z2|zone ?2|conversational|souple)\b/i.test(text))
    pace = "easy";
  else if (/\b(sprint|max effort|all out|à fond|a fond|hard|fast)\b/i.test(text)) pace = "hard";
  else if (/\b(moderate|modéré|modere|tempo|steady)\b/i.test(text)) pace = "moderate";
  text = text.replace(
    /\b(easy|facile|recovery|récup|recup|z1|z2|zone ?2|conversational|souple|sprint|max effort|all out|à fond|a fond|fast|steady|tempo)\b/gi,
    " ",
  );
  for (const [re, mod] of [
    [/\b(alternating|alt\.?|altern[ée]s?)\b/i, "alternating"],
    [/\b(each side|per side|par côté|par cote|e\/s|\/side)\b/i, "each_side"],
    [/\b(unbroken|ub)\b/i, "unbroken"],
    [/\bstrict\b/i, "strict"],
    [/\b(jumping|sautées?)\b/i, "jumping"],
    [/\bsynchro(nized)?\b/i, "synchro"],
  ] as Array<[RegExp, string]>) {
    if (re.test(text)) {
      modifiers.push(mod);
      text = text.replace(re, " ");
    }
  }
  const name = text
    .replace(/[():@,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) return null;

  const resolved = resolveExercise(name);
  const hinted: MovementPattern | null = resolved ? null : guessPattern(name);
  const mv: WodMovement = {
    raw: line.trim(),
    exerciseId: resolved ? resolved.exercise.id : null,
    name: resolved ? resolved.exercise.name : name,
    resolutionConfidence: resolved ? resolved.confidence : 0,
    hintedPattern: hinted,
    reps,
    repScheme,
    calories,
    caloriesAlt,
    distanceM,
    durationSec,
    heightCm: null,
    load,
    sets,
    modifiers,
    pace,
  };
  return mv;
}

function guessPattern(name: string): MovementPattern | null {
  const n = name.toLowerCase();
  if (/squat|lunge|fente|wall ?ball|thruster|pistol/.test(n)) return "squat";
  if (/dead|swing|hinge|good morning|rdl/.test(n)) return "hinge";
  if (/press|push|dip|hspu|handstand/.test(n)) return "vertical_push";
  if (/pull|row|chin|muscle|climb/.test(n)) return "vertical_pull";
  if (/carry|walk|farmer/.test(n)) return "carry";
  if (/run|jog|sprint|bike|ski|ergo|jump|du\b|burpee/.test(n)) return "locomotion";
  if (/sit|plank|hollow|core|abs|toe/.test(n)) return "rotation_core";
  if (/clean|snatch|jerk/.test(n)) return "olympic_lift";
  return null;
}

/** Recognise format headers. Returns true if the line was consumed as a header. */
function parseHeader(line: string, d: Draft): boolean {
  const l = line.trim();
  let m: RegExpExecArray | null;
  const capInline = /\b(?:cap|time\s*cap|tc)\s*:?\s*(\d+)/i.exec(l);
  if (capInline && !/^(?:time\s*cap|cap|tc)\b/i.test(l)) d.timeCapMin = Number(capInline[1]);
  if (
    (m =
      /^(?:amrap|as many (?:rounds|reps)[^\d]*)\s*(\d+)?\s*(?:min(?:utes?)?)?\b|^(\d+)\s*(?:min(?:utes?)?)\s*amrap/i.exec(
        l,
      ))
  ) {
    d.format = "amrap";
    d.durationMin = num(m[1] ?? m[2]);
    d.kind ??= "metcon";
    return true;
  }
  if (
    (m =
      /^(?:e(\d*)mom|every\s*(\d+)?\s*(min(?:utes?)?|s|sec)?\s*(?:on the minute)?)\s*(?:for|x|pour)?\s*(\d+)?\s*(?:min(?:utes?)?|rounds?)?/i.exec(
        l,
      )) &&
    /emom|every/i.test(l)
  ) {
    d.format = "emom";
    d.kind ??= "metcon";
    if (/altern/i.test(l)) d.alternating = true;
    const everyN = num(m[1]) ?? num(m[2]) ?? 1;
    const unitSec = m[3] && /^s/i.test(m[3]) ? 1 : 60;
    d.intervalSec = everyN * unitSec;
    const total = num(m[4]);
    if (total) {
      if (/rounds?/i.test(l)) {
        d.rounds = total;
        d.durationMin = (total * d.intervalSec) / 60;
      } else d.durationMin = total;
    }
    return true;
  }
  if (
    (m = /^(\d+)\s*(?:rounds?|rds?|tours?)\s*(?:for time|ft)?/i.exec(l)) ||
    (m = /^(\d+)\s*rft\b/i.exec(l))
  ) {
    d.format = "for_time";
    d.rounds = Number(m[1]);
    d.kind ??= "metcon";
    return true;
  }
  if (/^(for time|ft|pour le temps|chipper)\b/i.test(l)) {
    d.format = /chipper/i.test(l) ? "chipper" : "for_time";
    d.kind ??= "metcon";
    const cap = /cap\s*:?\s*(\d+)/i.exec(l);
    if (cap) d.timeCapMin = Number(cap[1]);
    return true;
  }
  if (/^tabata\b/i.test(l)) {
    d.format = "tabata";
    d.kind ??= "metcon";
    d.rounds = 8;
    d.durationMin = 4;
    return true;
  }
  if ((m = /^(?:time\s*cap|cap|tc)\s*:?\s*(\d+)/i.exec(l))) {
    d.timeCapMin = Number(m[1]);
    return true;
  }
  if ((m = /^(\d+(?:\s*-\s*\d+){2,})\s*(?:reps?)?\s*(?:of|:)?\s*$/i.exec(l))) {
    d.repScheme = m[1]!.split(/\s*-\s*/).map(Number);
    d.format ??= "for_time";
    d.kind ??= "metcon";
    return true;
  }
  if ((m = /^(?:rest|repos)\s*(\d+)\s*(min|s|sec)/i.exec(l))) {
    const v = Number(m[1]);
    d.restSec = /^m/i.test(m[2]!) ? v * 60 : v;
    return true;
  }
  if (
    (m =
      /^(\d+)\s*[x×]\s*(\d+)\s*(heavy|lourd|light|léger|leger|moderate|modéré|modere|build|@\s*\d+\s*%)?\s*$/i.exec(
        l,
      ))
  ) {
    d.format = "sets_reps";
    d.sets = Number(m[1]);
    d.reps = Number(m[2]);
    d.kind ??= "strength";
    const q = (m[3] ?? "").toLowerCase();
    if (q.startsWith("heav") || q === "lourd") d.loadQualifier = "heavy";
    else if (q.startsWith("light") || q.startsWith("l"))
      d.loadQualifier = q ? "light" : d.loadQualifier;
    else if (q.startsWith("build")) d.loadQualifier = "build";
    else if (q.startsWith("mod")) d.loadQualifier = "moderate";
    if (q.includes("%")) {
      const pct = Number(/(\d+)/.exec(q)?.[1]);
      for (const mv of d.movements)
        if (!mv.load) mv.load = { value: pct, unit: "percent_1rm", alt: null, qualifier: null };
    }
    return true;
  }
  if (
    (m =
      /^(?:build|monter|work up)\s*(?:to|à|a)?\s*(?:a\s*)?(?:heavy\s*)?(\d+)\s*(?:rm|rep max)?/i.exec(
        l,
      ))
  ) {
    d.format = "sets_reps";
    d.sets = 5;
    d.reps = Number(m[1]);
    d.kind ??= "strength";
    d.notes.push(l);
    return true;
  }
  return false;
}

function finalize(d: Draft): WodPart | null {
  if (!d.movements.length) return null;
  if (d.loadQualifier) {
    for (const mv of d.movements) {
      if (!mv.load) mv.load = { value: 0, unit: "kg", alt: null, qualifier: d.loadQualifier };
      else if (!mv.load.qualifier) mv.load = { ...mv.load, qualifier: d.loadQualifier };
    }
  }
  const kind: WodPartKind =
    d.kind ??
    (d.format === "sets_reps" || d.movements.every((m) => m.sets != null) ? "strength" : "metcon");
  let format: WodFormat =
    d.format ?? (kind === "strength" ? "sets_reps" : d.repScheme ? "for_time" : "not_timed");
  if (
    kind === "metcon" &&
    format === "not_timed" &&
    d.movements.length > 0 &&
    d.movements.some((m) => m.reps != null)
  )
    format = "for_time";
  if (format === "sets_reps" && d.sets == null) {
    const withSets = d.movements.find((m) => m.sets != null);
    if (withSets) {
      d.sets = withSets.sets;
      d.reps = withSets.reps;
    }
  }
  return {
    kind,
    format,
    title: d.title,
    durationMin: d.durationMin,
    timeCapMin: d.timeCapMin,
    rounds: d.rounds,
    repScheme: d.repScheme,
    intervalSec: d.intervalSec,
    restSec: d.restSec,
    alternating: d.alternating,
    sets: d.sets,
    reps: d.reps,
    movements: d.movements,
    notes: d.notes.length ? d.notes.join(" · ").slice(0, 500) : null,
  };
}

export function parseWodText(sourceText: string): NormalizedWod {
  const lines = sourceText
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const parts: WodPart[] = [];
  const warnings: string[] = [];
  let d = newDraft();
  let title: string | null = null;

  const flush = () => {
    const p = finalize(d);
    if (p) parts.push(p);
    d = newDraft();
  };

  for (const rawLine of lines) {
    let line = rawLine.replace(/^then\b[:\s]*/i, "").trim();
    if (!line) continue;
    if (SEPARATOR_LINE.test(line)) {
      if (d.movements.length) flush();
      continue;
    }

    // Section header ("A) Strength", "Metcon:", "WOD", "Part 2 —")
    const sectionMatch = SECTION_LABEL.exec(line);
    let kindFromHeader: WodPartKind | null = null;
    let remainder = line;
    if (sectionMatch) remainder = line.slice(sectionMatch[0].length).trim();
    for (const [re, kind] of HEADER_KIND) {
      if (re.test(remainder)) {
        kindFromHeader = kind;
        remainder = remainder
          .replace(re, "")
          .replace(/^[\s:—–-]+/, "")
          .trim();
        break;
      }
    }
    if (sectionMatch || kindFromHeader) {
      if (d.movements.length) flush();
      if (kindFromHeader) d.kind = kindFromHeader;
      if (!remainder) continue;
      line = remainder;
    }

    // Benchmark-style title line: quoted or all-caps single word before the workout ("Fran", "\"Helen\"")
    if (
      !title &&
      parts.length === 0 &&
      d.movements.length === 0 &&
      /^["“«]?[A-Z][a-zA-Z' ]{2,24}["”»]?$/.test(line) &&
      !parseHeader(line, d) &&
      !/\d/.test(line) &&
      !resolveExercise(line)
    ) {
      title = line.replace(/["“”«»]/g, "").trim();
      continue;
    }

    // Inline header + movements: "AMRAP 15: 5 pull ups, 10 push ups" — split on the first ':'.
    const colon = line.indexOf(":");
    if (colon > 0 && colon < line.length - 1) {
      const head = line.slice(0, colon).trim();
      const tail = line.slice(colon + 1).trim();
      const probe = newDraft();
      if (parseHeader(head, probe) && probe.format) {
        if (d.movements.length) flush();
        const kind = probe.kind ?? d.kind;
        Object.assign(d, { ...probe, kind, movements: [] });
        for (const seg of tail.split(/\s*[,;+]\s*|\s+\/\s+/)) {
          const mv = parseMovementLine(seg, d);
          if (mv) d.movements.push(mv);
        }
        continue;
      }
    }
    // Stand-alone header line. A new timed format after existing movements opens a new part;
    // a sets×reps scheme applies to the movement(s) just above ("Back squat" / "5 x 5 lourd").
    {
      const probe = newDraft();
      if (parseHeader(line, probe)) {
        if (d.movements.length && probe.format && NEW_PART_FORMATS.has(probe.format)) {
          flush();
        } else if (
          d.movements.length &&
          probe.format === "sets_reps" &&
          d.format &&
          d.format !== "sets_reps"
        ) {
          flush();
        }
        parseHeader(line, d);
        continue;
      }
    }
    // A new sets×reps movement line after a metcon → new strength part (and vice versa)
    if (d.format === "emom" && /^(?:min(?:ute)?\s*)?\d+\s*[).:-]\s+/i.test(line))
      d.alternating = true;
    const mv = parseMovementLine(line, d);
    if (!mv) {
      d.notes.push(line);
      continue;
    }
    const isStrengthLine = mv.sets != null;
    if (
      d.movements.length &&
      d.format &&
      ["amrap", "emom", "for_time", "tabata", "chipper"].includes(d.format) &&
      isStrengthLine
    ) {
      flush();
      d.kind = "strength";
    } else if (
      d.movements.length &&
      (d.format === "sets_reps" ||
        (d.format == null && d.movements.every((m) => m.sets != null))) &&
      !isStrengthLine &&
      mv.reps != null &&
      (mv.load == null || mv.load.qualifier == null)
    ) {
      // Uniform strength block continues when the movement also has sets; otherwise a new part starts.
      flush();
    }
    d.movements.push(mv);
  }
  flush();

  if (!parts.length) {
    warnings.push("Aucun mouvement reconnu");
    parts.push({
      kind: "metcon",
      format: "not_timed",
      title: null,
      durationMin: null,
      timeCapMin: null,
      rounds: null,
      repScheme: null,
      intervalSec: null,
      restSec: null,
      alternating: false,
      sets: null,
      reps: null,
      movements: [
        {
          raw: sourceText.slice(0, 200) || "?",
          exerciseId: null,
          name: sourceText.slice(0, 120) || "?",
          resolutionConfidence: 0,
          hintedPattern: null,
          reps: null,
          repScheme: null,
          calories: null,
          caloriesAlt: null,
          distanceM: null,
          durationSec: null,
          heightCm: null,
          load: null,
          sets: null,
          modifiers: [],
          pace: null,
        },
      ],
      notes: null,
    });
  }

  const movements = parts.flatMap((p) => p.movements);
  const unknown = movements.filter((m) => !m.exerciseId).length;
  const lowRes = movements.filter((m) => m.exerciseId && m.resolutionConfidence < 0.9).length;
  const noQty = movements.filter(
    (m) =>
      m.reps == null &&
      m.repScheme == null &&
      m.calories == null &&
      m.distanceM == null &&
      m.durationSec == null &&
      !parts.find((p) => p.movements.includes(m))?.repScheme &&
      !parts.find((p) => p.movements.includes(m))?.reps,
  ).length;
  let parseConfidence = 0.85 - 0.15 * unknown - 0.05 * lowRes - 0.1 * noQty;
  if (parts.some((p) => p.kind === "metcon" && p.format === "not_timed")) parseConfidence -= 0.1;
  parseConfidence = Math.max(0.1, Math.min(0.9, Math.round(parseConfidence * 100) / 100));
  if (unknown) warnings.push(`${unknown} mouvement(s) non reconnu(s)`);

  return NormalizedWodSchema.parse({
    title,
    sourceText: sourceText.slice(0, 8000),
    parts,
    parseConfidence,
    parser: "HEURISTIC",
    parserVersion: HEURISTIC_PARSER_VERSION,
    warnings,
  });
}
