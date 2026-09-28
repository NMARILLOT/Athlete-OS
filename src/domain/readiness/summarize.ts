import { READINESS_SIGNALS } from "../athlete-model/defaults";
import type { IsoDateTime } from "../core/dates";
import type {
  ReadinessBand,
  ReadinessBaselines,
  ReadinessDeclared,
  ReadinessMeasured,
  ReadinessSignal,
  ReadinessSummary,
} from "./types";

export const READINESS_ALGORITHM_VERSION = "readiness_summary_v1" as const;

export interface SummarizeReadinessInput {
  declared?: ReadinessDeclared | null;
  measured?: ReadinessMeasured | null;
  baselines?: ReadinessBaselines | null;
  /** Passed in by the service: the domain never reads the clock. */
  computedAt: IsoDateTime;
}

const isNum = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);
const round1 = (x: number): number => Math.round(x * 10) / 10;

/**
 * Declared answers → signals (source USER): energy 😫, soreness ≥ 2, motivation 😫, unusual pain.
 */
function declaredSignals(d: ReadinessDeclared): ReadinessSignal[] {
  const out: ReadinessSignal[] = [];
  if (d.energy === 1)
    out.push({ key: "energy_low", direction: "worse", detail: "Énergie 😫", source: "USER" });
  if (d.soreness >= 2) {
    out.push({
      key: "soreness_high",
      direction: "worse",
      detail: `Courbatures ${d.soreness}/3`,
      source: "USER",
    });
  }
  if (d.motivation === 1)
    out.push({ key: "motivation_low", direction: "worse", detail: "Envie 😫", source: "USER" });
  if (d.unusualPain)
    out.push({
      key: "unusual_pain",
      direction: "worse",
      detail: "Douleur inhabituelle",
      source: "USER",
    });
  return out;
}

/**
 * Measured values → signals. Raw thresholds (sleep < 6 h, body battery < 35) are GARMIN signals;
 * deviations from a personal baseline are CALCULATED. Thresholds come from READINESS_SIGNALS.
 */
function measuredSignals(
  m: ReadinessMeasured,
  b: ReadinessBaselines,
  notes: string[],
): ReadinessSignal[] {
  const out: ReadinessSignal[] = [];
  const t = READINESS_SIGNALS;

  if (isNum(m.restingHr)) {
    const base = b.restingHr;
    if (base) {
      const delta = m.restingHr - base.center;
      const pct = base.center > 0 ? (delta / base.center) * 100 : 0;
      if (delta >= t.rhrAboveMedianBpm || pct >= t.rhrAboveMedianPct) {
        out.push({
          key: "rhr_high",
          direction: "worse",
          detail: `FC repos ${Math.round(m.restingHr)} bpm (+${round1(delta)} vs médiane ${round1(base.center)})`,
          source: "CALCULATED",
        });
      }
    } else {
      notes.push("Pas de baseline FC repos : valeur non interprétée.");
    }
  }

  if (isNum(m.hrvRmssd) && m.hrvRmssd > 0) {
    const base = b.hrvLnRmssd;
    if (base) {
      const ln = Math.log(m.hrvRmssd);
      const delta = ln - base.center;
      const sdLimit = base.sd != null && base.sd > 0 ? t.hrvBelowMeanSd * base.sd : null;
      const pctLimit = -Math.log(1 - t.hrvBelowMeanPct / 100);
      const baselineMs = Math.round(Math.exp(base.center));
      if ((sdLimit != null && delta <= -sdLimit) || delta <= -pctLimit) {
        out.push({
          key: "hrv_low",
          direction: "worse",
          detail: `HRV ${Math.round(m.hrvRmssd)} ms sous la baseline (${baselineMs} ms)`,
          source: "CALCULATED",
        });
      } else if ((sdLimit != null && delta >= sdLimit) || delta >= pctLimit) {
        out.push({
          key: "hrv_high",
          direction: "better",
          detail: `HRV ${Math.round(m.hrvRmssd)} ms au-dessus de la baseline (${baselineMs} ms)`,
          source: "CALCULATED",
        });
      }
    } else {
      notes.push("Pas de baseline HRV : valeur non interprétée.");
    }
  }

  if (isNum(m.sleepHours)) {
    const base = b.sleepHours;
    const h = round1(m.sleepHours);
    if (m.sleepHours < t.sleepBelowHours) {
      out.push({
        key: "sleep_short",
        direction: "worse",
        detail: `Sommeil ${h} h (< ${t.sleepBelowHours} h)`,
        source: "GARMIN",
      });
    } else if (base && m.sleepHours < base.center - t.sleepBelowMedianHours) {
      out.push({
        key: "sleep_short",
        direction: "worse",
        detail: `Sommeil ${h} h (médiane ${round1(base.center)} h)`,
        source: "CALCULATED",
      });
    } else if (base && m.sleepHours >= base.center + 1) {
      out.push({
        key: "sleep_long",
        direction: "better",
        detail: `Sommeil ${h} h (médiane ${round1(base.center)} h)`,
        source: "CALCULATED",
      });
    }
  }

  if (isNum(m.bodyBattery) && m.bodyBattery < t.bodyBatteryBelow) {
    out.push({
      key: "body_battery_low",
      direction: "worse",
      detail: `Body Battery ${Math.round(m.bodyBattery)} (< ${t.bodyBatteryBelow})`,
      source: "GARMIN",
    });
  }
  return out;
}

function hasAnyMeasured(m: ReadinessMeasured | null | undefined): boolean {
  if (!m) return false;
  return [m.sleepHours, m.sleepScore, m.restingHr, m.hrvRmssd, m.stress, m.bodyBattery].some(isNum);
}

/**
 * Band (ENGINE.md §2 `readinessBand`):
 *  - poor  = (≥ 1 declared worse signal AND ≥ 2 worse signals in total) OR ≥ 2 measured worse signals
 *  - good  = no worse signal AND (declared answers present, or measured data present)
 *  - ok    = everything else (including "no data at all")
 * A single measured signal alone is never poor (spec §91).
 */
function bandFor(
  declaredCount: number,
  measuredCount: number,
  hasDeclared: boolean,
  hasMeasured: boolean,
): ReadinessBand {
  const total = declaredCount + measuredCount;
  if ((declaredCount >= 1 && total >= 2) || measuredCount >= 2) return "poor";
  if (total === 0 && (hasDeclared || hasMeasured)) return "good";
  return "ok";
}

/**
 * Readiness summary (spec §21, ENGINE.md §2). Deterministic; thresholds in
 * `athlete-model/defaults.ts` (READINESS_SIGNALS). Notes are short French explanations for the UI.
 */
export function summarizeReadiness(input: SummarizeReadinessInput): ReadinessSummary {
  const notes: string[] = [];
  const declared = input.declared ?? null;
  const measured = input.measured ?? null;
  const baselines = input.baselines ?? {};
  const hasDeclared = declared != null;
  const hasMeasured = hasAnyMeasured(measured);

  const signals: ReadinessSignal[] = [
    ...(declared ? declaredSignals(declared) : []),
    ...(measured ? measuredSignals(measured, baselines, notes) : []),
  ];
  const declaredCount = signals.filter(
    (s) => s.source === "USER" && s.direction === "worse",
  ).length;
  const measuredCount = signals.filter(
    (s) => s.source !== "USER" && s.direction === "worse",
  ).length;
  const band = bandFor(declaredCount, measuredCount, hasDeclared, hasMeasured);

  if (!hasDeclared && !hasMeasured) notes.push("Aucune donnée de readiness : état inconnu.");
  else if (!hasDeclared) notes.push("Pas de réponse ce matin : mesures seules.");
  else if (!hasMeasured) notes.push("Pas de mesure Garmin : ressenti seul.");
  if (band === "poor") notes.push(`Readiness basse : ${declaredCount + measuredCount} signaux.`);
  else if (measuredCount === 1 && declaredCount === 0)
    notes.push("Un seul signal mesuré : pas de conclusion.");
  else if (declaredCount === 1 && measuredCount === 0)
    notes.push("Un seul signal déclaré : à surveiller.");

  return {
    algorithmVersion: READINESS_ALGORITHM_VERSION,
    computedAt: input.computedAt,
    band,
    signals,
    declaredCount,
    measuredCount,
    hasDeclared,
    hasMeasured,
    notes,
  };
}
