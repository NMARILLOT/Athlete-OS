import "server-only";
import { and, asc, desc, eq, lte } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  athleteProfiles,
  cardioWorkouts,
  hrZoneSets,
  workoutAnalyses,
  workouts,
} from "@/db/schema";
import {
  CARDIO_BUILDER_ALGORITHM_VERSION,
  CARDIO_PRESET_KINDS,
  CARDIO_PRESETS,
  CardioWorkoutSpecSchema,
  HR_ZONE_CEILING_BPM,
  estimateDurationMin,
  expectedLoadProfile,
  flattenSteps,
  zonesFromLthr,
  type CardioLeafKind,
  type CardioLoadProfile,
  type CardioPresetKind,
  type CardioStep,
  type CardioTarget,
  type CardioWorkoutSpec,
  type FlatCardioStep,
  type HrZone,
  type HrZoneMethod,
  type HrZoneSet,
} from "@/domain/cardio";
import {
  LOAD_DIMENSION_VALUES,
  type CardioKind,
  type Confidence,
  type DataSource,
  type Feeling,
  type IntensityBand,
  type LoadDimension,
  type Modality,
  type StimulusKey,
  type WorkoutSource,
  type WorkoutStatus,
} from "@/domain/core";
import type { IsoDate } from "@/domain/core/dates";
import { DIMENSION_LABEL_FR, STIMULUS_LABEL_FR } from "@/domain/engine";
import { AppError, NotFoundError, ValidationError } from "@/server/errors";
import { FeatureDisabledError, flags } from "@/server/flags";
import { errorFields, log } from "@/server/logging";
import { garminProvider, type GarminProvider } from "@/server/providers/garmin";
import { instantFor, localMinute } from "@/server/time";
import { analysisRowFromProfile, completeWorkout } from "./workout.service";

/**
 * Cardio mode (spec §12, §16, §80–81; ARCHITECTURE §3 `/train/cardio/*`).
 *
 * A cardio workout is a `workouts` row (type `cardio`) plus one `cardio_workouts` row holding the
 * builder spec (steps, modality, kind) and the Garmin push state. Its planned analysis is the
 * deterministic `expectedLoadProfile` of the spec (source CALCULATED, versioned). Engine-created
 * cardio workouts have no `cardio_workouts` row until this service materialises one from the
 * preset the engine picked (`workout_analyses.input_ref`), so Today's START lands on a real spec.
 *
 * Garmin: the provider is behind `flags().garmin`. Every push outcome — including provider
 * exceptions — is stored on the row (`garmin_sync_status` + `last_sync_error`); the workout itself
 * is never touched by a failed push (spec §81 "never lose the session").
 */

export const CARDIO_EXPECTED_RPE: Record<IntensityBand, number> = {
  easy: 4,
  moderate: 6.5,
  hard: 8,
};
/** Builder analyses are model outputs of a user-declared structure: HIGH but not measured. */
const BUILDER_CONFIDENCE = 0.8;
/** Elapsed time beyond this is a forgotten session, not a measurement (same cap as feedback input). */
const MAX_ELAPSED_MIN = 600;

export const GARMIN_SYNC_STATUS_VALUES = ["not_sent", "pending", "synced", "failed"] as const;
export type GarminSyncStatus = (typeof GARMIN_SYNC_STATUS_VALUES)[number];

// ---------------------------------------------------------------------------
// View models (plain data — components import these with `import type`)
// ---------------------------------------------------------------------------

export interface CardioStepView {
  /** 1-based position in the unrolled sequence the watch executes. */
  index: number;
  kind: CardioLeafKind;
  kindLabel: string;
  durationSec: number | null;
  distanceM: number | null;
  /** "45 min" / "5,00 km" / "au bouton lap". */
  extentLabel: string;
  target: CardioTarget | null;
  /** "Z2 (145–152 bpm)" when a zone set applies, "Z2" otherwise, "libre" for open steps. */
  targetLabel: string;
  notes: string | null;
}

export interface CardioLoadView {
  intensity: IntensityBand;
  intensityLabel: string;
  /** Minutes the steps add up to (lap-button steps count 0 — never invented). */
  durationMin: number;
  impactUnits: number;
  vector: Array<{ key: LoadDimension; label: string; value: number }>;
  credits: Array<{ key: StimulusKey; label: string; value: number }>;
  /** Always a model output. */
  estimated: true;
}

export interface ZoneSetView {
  id: string;
  validFrom: IsoDate;
  method: HrZoneMethod;
  lthr: number | null;
  maxHr: number | null;
  restingHr: number | null;
  zones: HrZone[];
  source: DataSource;
  confidence: Confidence;
}

export interface CardioGarminView {
  status: GarminSyncStatus;
  workoutId: string | null;
  scheduledFor: IsoDate | null;
  lastError: string | null;
  providerName: GarminProvider["name"];
  /** `flags().garmin` — when false the UI shows "bientôt" and never calls the provider. */
  enabled: boolean;
  /** Provider account link (mock: always; official: false until OAuth exists). */
  connected: boolean;
}

export interface CardioWorkoutView {
  id: string;
  date: IsoDate;
  status: WorkoutStatus;
  source: WorkoutSource;
  title: string;
  startMinute: number | null;
  /** ISO instant of the (planned, then actual) start — the in-progress timer derives from it. */
  startAt: string | null;
  plannedDurationMin: number | null;
  actualDurationMin: number | null;
  plannedIntensity: IntensityBand | null;
  fixed: boolean;
  rpe: number | null;
  feeling: Feeling | null;
  painReported: boolean;
  finishedAt: string | null;
  modality: Modality;
  modalityLabel: string;
  kind: CardioKind;
  kindLabel: string;
  spec: CardioWorkoutSpec;
  flatSteps: CardioStepView[];
  /** `estimateDurationMin(spec)` — 0 when every step ends on the lap button. */
  estimatedMin: number;
  expectedLoad: CardioLoadView;
  zoneSet: ZoneSetView | null;
  garmin: CardioGarminView;
}

/** Garmin dependencies, injectable so tests can swap the provider or the flag. */
export interface GarminContext {
  enabled: boolean;
  provider: GarminProvider;
}

function defaultGarminContext(): GarminContext {
  return { enabled: flags().garmin, provider: garminProvider() };
}

// ---------------------------------------------------------------------------
// French labels (server side; the builder island keeps its own copy in components/cardio/labels)
// ---------------------------------------------------------------------------

const MODALITY_FR: Record<Modality, string> = {
  running: "Course",
  bike: "Vélo",
  row: "Rameur",
  ski: "SkiErg",
  swimming: "Natation",
  walking: "Marche",
  strength: "Force",
  gymnastics: "Gymnastique",
  weightlifting: "Haltéro",
  mixed_modal: "Mixte",
  mobility: "Mobilité",
  other: "Autre",
};

const CARDIO_KIND_FR: Record<CardioKind, string> = {
  zone2: "Zone 2",
  long: "Sortie longue",
  recovery: "Récupération",
  tempo: "Tempo",
  threshold: "Seuil",
  vo2max: "VO2max",
  intervals: "Intervalles",
  fartlek: "Fartlek",
  hills: "Côtes",
  strides: "Lignes droites",
  test: "Test",
  free: "Libre",
};

const STEP_KIND_FR: Record<CardioLeafKind, string> = {
  warmup: "Échauffement",
  work: "Effort",
  recovery: "Récup",
  cooldown: "Retour au calme",
  rest: "Repos",
};

const INTENSITY_FR: Record<IntensityBand, string> = {
  easy: "facile",
  moderate: "modérée",
  hard: "dure",
};

function formatSeconds(sec: number): string {
  if (sec < 60) return `${Math.round(sec)} s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return s === 0 ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h ${m} min ${s} s`;
  return s === 0 ? `${m} min` : `${m}:${String(s).padStart(2, "0")}`;
}

function formatPaceRange(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function describeRange(
  min: number | undefined,
  max: number | undefined,
  format: (v: number) => string,
  unit: string,
): string | null {
  if (min != null && max != null)
    return min === max ? `${format(min)}${unit}` : `${format(min)}–${format(max)}${unit}`;
  if (min != null) return `≥ ${format(min)}${unit}`;
  if (max != null) return `≤ ${format(max)}${unit}`;
  return null;
}

/** Target label; HR zones become explicit bpm bounds when a versioned zone set applies (spec §16). */
export function describeCardioTarget(
  target: CardioTarget | null | undefined,
  zones: readonly HrZone[] | null,
): string {
  if (!target || target.type === "open") return "libre";
  const plain = String;
  switch (target.type) {
    case "hr_zone": {
      const z = target.zone;
      if (z == null) return "zone FC";
      const band = zones?.find((b) => b.zone === z);
      if (!band) return `Z${z}`;
      if (band.minBpm <= 0) return `Z${z} (≤ ${band.maxBpm} bpm)`;
      if (band.maxBpm >= HR_ZONE_CEILING_BPM) return `Z${z} (≥ ${band.minBpm} bpm)`;
      return `Z${z} (${band.minBpm}–${band.maxBpm} bpm)`;
    }
    case "hr_bpm":
      return describeRange(target.min, target.max, plain, " bpm") ?? "FC";
    case "pace_sec_km":
      return describeRange(target.min, target.max, formatPaceRange, " /km") ?? "allure";
    case "power_w":
      return describeRange(target.min, target.max, plain, " W") ?? "puissance";
    case "cadence":
      return describeRange(target.min, target.max, plain, " /min") ?? "cadence";
  }
}

function describeExtent(step: FlatCardioStep): string {
  if (step.durationSec != null && step.durationSec > 0) return formatSeconds(step.durationSec);
  if (step.distanceM != null && step.distanceM > 0)
    return step.distanceM >= 1000
      ? `${(step.distanceM / 1000).toFixed(step.distanceM % 1000 === 0 ? 0 : 2).replace(".", ",")} km`
      : `${Math.round(step.distanceM)} m`;
  return "au bouton lap";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type WorkoutRow = typeof workouts.$inferSelect;
type CardioRow = typeof cardioWorkouts.$inferSelect;
type ZoneSetRow = typeof hrZoneSets.$inferSelect;

function parseSpec(input: unknown): CardioWorkoutSpec {
  const parsed = CardioWorkoutSpecSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Séance cardio invalide", parsed.error.issues);
  return parsed.data;
}

function isPresetKind(value: string): value is CardioPresetKind {
  return (CARDIO_PRESET_KINDS as readonly string[]).includes(value);
}

function isSyncStatus(value: string): value is GarminSyncStatus {
  return (GARMIN_SYNC_STATUS_VALUES as readonly string[]).includes(value);
}

function specFromRow(w: WorkoutRow, c: CardioRow): CardioWorkoutSpec {
  return { modality: c.modality, kind: c.workoutKind, title: w.title, steps: c.steps };
}

/** Planned minutes from the estimate; null (never a fake number) when every step ends on the lap button. */
function plannedMinutes(estimatedMin: number): number | null {
  const rounded = Math.round(estimatedMin);
  return rounded > 0 ? rounded : null;
}

/** Key-order-independent JSON: JSONB re-orders keys, so a plain stringify would always differ. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}

/** Modality guessed from a catalog title for cardio workouts the engine created without a spec. */
export function guessModalityFromTitle(title: string): Modality {
  const t = title.toLowerCase();
  if (/(vélo|velo|bike|cycl|spin)/.test(t)) return "bike";
  if (/(rameur|row)/.test(t)) return "row";
  if (/ski/.test(t)) return "ski";
  if (/(marche|walk)/.test(t)) return "walking";
  if (/(nage|natation|swim)/.test(t)) return "swimming";
  if (/(course|footing|run|trail|jog|sortie)/.test(t)) return "running";
  return "other";
}

function fallbackSpec(w: WorkoutRow): CardioWorkoutSpec {
  const step: CardioStep =
    w.plannedDurationMin != null && w.plannedDurationMin > 0
      ? { kind: "work", durationSec: w.plannedDurationMin * 60, target: { type: "open" } }
      : { kind: "work", target: { type: "open" } };
  return { modality: guessModalityFromTitle(w.title), kind: "free", title: w.title, steps: [step] };
}

function toZoneSetView(row: ZoneSetRow): ZoneSetView {
  return {
    id: row.id,
    validFrom: row.validFrom,
    method: row.method,
    lthr: row.lthr,
    maxHr: row.maxHr,
    restingHr: row.restingHr,
    zones: row.zones,
    source: row.source,
    confidence: row.confidence,
  };
}

function toLoadView(profile: CardioLoadProfile): CardioLoadView {
  return {
    intensity: profile.intensity,
    intensityLabel: INTENSITY_FR[profile.intensity],
    durationMin: profile.durationMin,
    impactUnits: profile.impactUnits,
    vector: LOAD_DIMENSION_VALUES.map((key) => ({
      key,
      label: DIMENSION_LABEL_FR[key],
      value: profile.loadVector[key],
    })),
    credits: (Object.entries(profile.expectedCredits) as Array<[StimulusKey, number]>)
      .filter(([, v]) => v > 0)
      .map(([key, value]) => ({ key, label: STIMULUS_LABEL_FR[key], value })),
    estimated: true,
  };
}

function toStepViews(
  steps: readonly CardioStep[],
  zones: readonly HrZone[] | null,
): CardioStepView[] {
  return flattenSteps(steps).map((s, i) => ({
    index: i + 1,
    kind: s.kind,
    kindLabel: STEP_KIND_FR[s.kind],
    durationSec: s.durationSec ?? null,
    distanceM: s.distanceM ?? null,
    extentLabel: describeExtent(s),
    target: s.target ?? null,
    targetLabel: describeCardioTarget(s.target, zones),
    notes: s.notes ?? null,
  }));
}

async function toGarminView(
  c: CardioRow,
  userId: string,
  garmin: GarminContext,
): Promise<CardioGarminView> {
  return {
    status: isSyncStatus(c.garminSyncStatus) ? c.garminSyncStatus : "not_sent",
    workoutId: c.garminWorkoutId,
    scheduledFor: c.garminScheduledFor,
    lastError: c.lastSyncError,
    providerName: garmin.provider.name,
    enabled: garmin.enabled,
    connected: garmin.enabled ? await garmin.provider.isConnected(userId) : false,
  };
}

function describeGarminError(err: unknown): string {
  if (err instanceof AppError) return err.message;
  return "Erreur inattendue pendant l'envoi vers Garmin. Réessaie.";
}

// ---------------------------------------------------------------------------
// Zones (spec §16 — versioned; a session keeps the set valid on its date)
// ---------------------------------------------------------------------------

async function zoneSetById(db: Db, userId: string, id: string): Promise<ZoneSetView | null> {
  const [row] = await db
    .select()
    .from(hrZoneSets)
    .where(and(eq(hrZoneSets.id, id), eq(hrZoneSets.userId, userId)))
    .limit(1);
  return row ? toZoneSetView(row) : null;
}

/**
 * The zone set in force on `date`: latest stored set with `valid_from ≤ date`; otherwise a set
 * derived once from the profile's manual LTHR (`zonesFromLthr`, source USER) and persisted so every
 * workout references a stable `zone_set_id`; null when nothing is known (never 220 − age).
 */
export async function resolveZoneSet(
  db: Db,
  userId: string,
  date: IsoDate,
): Promise<ZoneSetView | null> {
  const [existing] = await db
    .select()
    .from(hrZoneSets)
    .where(and(eq(hrZoneSets.userId, userId), lte(hrZoneSets.validFrom, date)))
    .orderBy(desc(hrZoneSets.validFrom), desc(hrZoneSets.createdAt))
    .limit(1);
  if (existing) return toZoneSetView(existing);

  const [profile] = await db
    .select({ lthr: athleteProfiles.lthrManual })
    .from(athleteProfiles)
    .where(eq(athleteProfiles.userId, userId))
    .limit(1);
  if (profile?.lthr == null) return null;

  let derived: HrZoneSet;
  try {
    derived = zonesFromLthr(profile.lthr, date, "USER");
  } catch {
    // A typo'd profile value must never break a page: no zones rather than wrong zones.
    return null;
  }
  const lthr = derived.lthr ?? profile.lthr;
  // One derived row per manual LTHR value, even when it was first derived for a later date.
  const [same] = await db
    .select()
    .from(hrZoneSets)
    .where(
      and(
        eq(hrZoneSets.userId, userId),
        eq(hrZoneSets.method, "lthr"),
        eq(hrZoneSets.source, "USER"),
        eq(hrZoneSets.lthr, lthr),
      ),
    )
    .orderBy(asc(hrZoneSets.validFrom))
    .limit(1);
  if (same) return toZoneSetView(same);

  const [inserted] = await db
    .insert(hrZoneSets)
    .values({
      userId,
      validFrom: derived.validFrom,
      method: derived.method,
      lthr,
      maxHr: derived.maxHr ?? null,
      restingHr: derived.restingHr ?? null,
      zones: derived.zones,
      source: derived.source,
      confidence: derived.confidence,
    })
    .returning();
  if (!inserted) throw new Error("hr_zone_sets insert failed");
  log.info("cardio.zones_derived", { userId, kind: "lthr_manual" });
  return toZoneSetView(inserted);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface CardioRows {
  w: WorkoutRow;
  c: CardioRow;
}

/**
 * Lazily materialise the `cardio_workouts` row of an engine-created cardio workout: the preset
 * named by the planned analysis' `input_ref` (Today's START on a catalog option), else a single
 * open step of the planned duration with the modality guessed from the title.
 */
async function materialiseCardioRow(db: Db, userId: string, w: WorkoutRow): Promise<CardioRow> {
  const [planned] = await db
    .select({ inputRef: workoutAnalyses.inputRef })
    .from(workoutAnalyses)
    .where(
      and(
        eq(workoutAnalyses.workoutId, w.id),
        eq(workoutAnalyses.userId, userId),
        eq(workoutAnalyses.phase, "planned"),
      ),
    )
    .limit(1);
  const ref = planned?.inputRef ?? null;
  const preset = ref && isPresetKind(ref) ? CARDIO_PRESETS[ref] : null;
  const spec: CardioWorkoutSpec = preset ? { ...preset, title: w.title } : fallbackSpec(w);
  const zoneSet = await resolveZoneSet(db, userId, w.date);
  await db
    .insert(cardioWorkouts)
    .values({
      userId,
      workoutId: w.id,
      modality: spec.modality,
      workoutKind: spec.kind,
      steps: spec.steps,
      zoneSetId: zoneSet?.id ?? null,
    })
    .onConflictDoNothing({ target: cardioWorkouts.workoutId });
  const [c] = await db
    .select()
    .from(cardioWorkouts)
    .where(and(eq(cardioWorkouts.workoutId, w.id), eq(cardioWorkouts.userId, userId)))
    .limit(1);
  if (!c) throw new Error("cardio_workouts materialisation failed");
  log.info("cardio.materialised", {
    userId,
    workoutId: w.id,
    kind: preset && ref ? ref : "fallback",
  });
  return c;
}

/** The user's cardio workout and its spec row (materialised when missing); null when not theirs. */
async function loadCardio(db: Db, userId: string, workoutId: string): Promise<CardioRows | null> {
  const [w] = await db
    .select()
    .from(workouts)
    .where(and(eq(workouts.id, workoutId), eq(workouts.userId, userId)))
    .limit(1);
  if (!w || w.type !== "cardio") return null;
  const [c] = await db
    .select()
    .from(cardioWorkouts)
    .where(and(eq(cardioWorkouts.workoutId, w.id), eq(cardioWorkouts.userId, userId)))
    .limit(1);
  return { w, c: c ?? (await materialiseCardioRow(db, userId, w)) };
}

function requireEditable(w: WorkoutRow): void {
  if (w.status !== "planned" && w.status !== "auto_adjusted")
    throw new ValidationError(
      "Cette séance est déjà démarrée ou terminée : elle ne peut plus être modifiée.",
    );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Builder → planned cardio workout + spec row + planned analysis (one transaction). */
export async function createCardioWorkout(
  db: Db,
  userId: string,
  opts: {
    date: IsoDate;
    startMinute: number | null;
    timezone: string;
    spec: CardioWorkoutSpec;
    presetKind?: CardioPresetKind | null;
  },
): Promise<{ id: string }> {
  const spec = parseSpec(opts.spec);
  const estimatedMin = estimateDurationMin(spec);
  const profile = expectedLoadProfile(spec);
  const zoneSet = await resolveZoneSet(db, userId, opts.date);
  const inputRef = opts.presetKind ?? null;

  const id = await db.transaction(async (tx) => {
    const [w] = await tx
      .insert(workouts)
      .values({
        userId,
        type: "cardio",
        source: "planned_user",
        status: "planned",
        date: opts.date,
        startAt:
          opts.startMinute != null ? instantFor(opts.date, opts.startMinute, opts.timezone) : null,
        plannedDurationMin: plannedMinutes(estimatedMin),
        title: spec.title,
        plannedIntensity: profile.intensity,
        intensitySource: "CALCULATED",
        fixed: false,
        expectedRpe: CARDIO_EXPECTED_RPE[profile.intensity],
      })
      .returning({ id: workouts.id });
    if (!w) throw new Error("workout insert failed");
    await tx.insert(cardioWorkouts).values({
      userId,
      workoutId: w.id,
      modality: spec.modality,
      workoutKind: spec.kind,
      steps: spec.steps,
      zoneSetId: zoneSet?.id ?? null,
    });
    await tx.insert(workoutAnalyses).values({
      userId,
      workoutId: w.id,
      phase: "planned",
      date: opts.date,
      ...analysisRowFromProfile(
        profile,
        "CALCULATED",
        CARDIO_BUILDER_ALGORITHM_VERSION,
        BUILDER_CONFIDENCE,
        inputRef,
      ),
    });
    return w.id;
  });
  log.info("cardio.created", { userId, workoutId: id, kind: spec.kind });
  return { id };
}

/** Everything `/train/cardio/[id]` renders; null when the workout is not the user's cardio workout. */
export async function getCardioWorkout(
  db: Db,
  userId: string,
  workoutId: string,
  opts: { timezone: string; garmin?: GarminContext },
): Promise<CardioWorkoutView | null> {
  const rows = await loadCardio(db, userId, workoutId);
  if (!rows) return null;
  const { w, c } = rows;

  let zoneSet = c.zoneSetId ? await zoneSetById(db, userId, c.zoneSetId) : null;
  if (!zoneSet) {
    zoneSet = await resolveZoneSet(db, userId, w.date);
    if (zoneSet)
      await db
        .update(cardioWorkouts)
        .set({ zoneSetId: zoneSet.id })
        .where(and(eq(cardioWorkouts.id, c.id), eq(cardioWorkouts.userId, userId)));
  }

  const spec = specFromRow(w, c);
  const garmin = opts.garmin ?? defaultGarminContext();
  return {
    id: w.id,
    date: w.date,
    status: w.status,
    source: w.source,
    title: w.title,
    startMinute: w.startAt ? localMinute(w.startAt, opts.timezone) : null,
    startAt: w.startAt ? w.startAt.toISOString() : null,
    plannedDurationMin: w.plannedDurationMin,
    actualDurationMin: w.actualDurationMin,
    plannedIntensity: w.plannedIntensity,
    fixed: w.fixed,
    rpe: w.rpe,
    feeling: w.feeling,
    painReported: w.painReported,
    finishedAt: w.finishedAt ? w.finishedAt.toISOString() : null,
    modality: c.modality,
    modalityLabel: MODALITY_FR[c.modality],
    kind: c.workoutKind,
    kindLabel: CARDIO_KIND_FR[c.workoutKind],
    spec,
    flatSteps: toStepViews(spec.steps, zoneSet?.zones ?? null),
    estimatedMin: estimateDurationMin(spec),
    expectedLoad: toLoadView(expectedLoadProfile(spec)),
    zoneSet,
    garmin: await toGarminView(c, userId, garmin),
  };
}

/**
 * Replace the spec of a planned workout: title / duration / intensity / planned analysis are
 * recomputed; when the steps changed, a previous Garmin push is stale and the status returns to
 * `not_sent` so the athlete re-sends.
 */
export async function updateCardioSpec(
  db: Db,
  userId: string,
  workoutId: string,
  input: CardioWorkoutSpec,
): Promise<void> {
  const spec = parseSpec(input);
  const rows = await loadCardio(db, userId, workoutId);
  if (!rows) throw new NotFoundError("Séance cardio");
  const { w, c } = rows;
  requireEditable(w);

  const estimatedMin = estimateDurationMin(spec);
  const profile = expectedLoadProfile(spec);
  const stepsChanged =
    c.modality !== spec.modality ||
    c.workoutKind !== spec.kind ||
    canonicalJson(c.steps) !== canonicalJson(spec.steps);
  const [planned] = await db
    .select({ inputRef: workoutAnalyses.inputRef })
    .from(workoutAnalyses)
    .where(
      and(
        eq(workoutAnalyses.workoutId, w.id),
        eq(workoutAnalyses.userId, userId),
        eq(workoutAnalyses.phase, "planned"),
      ),
    )
    .limit(1);
  const analysis = analysisRowFromProfile(
    profile,
    "CALCULATED",
    CARDIO_BUILDER_ALGORITHM_VERSION,
    BUILDER_CONFIDENCE,
    planned?.inputRef ?? null,
  );

  await db.transaction(async (tx) => {
    await tx
      .update(workouts)
      .set({
        title: spec.title,
        plannedDurationMin: plannedMinutes(estimatedMin),
        plannedIntensity: profile.intensity,
        intensitySource: "CALCULATED",
        expectedRpe: CARDIO_EXPECTED_RPE[profile.intensity],
      })
      .where(and(eq(workouts.id, w.id), eq(workouts.userId, userId)));
    await tx
      .update(cardioWorkouts)
      .set({
        modality: spec.modality,
        workoutKind: spec.kind,
        steps: spec.steps,
        ...(stepsChanged
          ? {
              garminSyncStatus: "not_sent",
              garminWorkoutId: null,
              garminScheduledFor: null,
              lastSyncError: null,
            }
          : {}),
      })
      .where(and(eq(cardioWorkouts.id, c.id), eq(cardioWorkouts.userId, userId)));
    await tx
      .insert(workoutAnalyses)
      .values({ userId, workoutId: w.id, phase: "planned", date: w.date, ...analysis })
      .onConflictDoUpdate({
        target: [workoutAnalyses.workoutId, workoutAnalyses.phase],
        set: { ...analysis, computedAt: new Date() },
      });
  });
  log.info("cardio.updated", { userId, workoutId: w.id, kind: spec.kind });
}

/**
 * SEND TO GARMIN (spec §81): create the workout on the provider, schedule it on the workout's date,
 * store the outcome. A provider failure or exception is recorded as `failed` with a short French
 * message — the workout and its spec are never deleted or altered.
 */
export async function sendToGarmin(
  db: Db,
  userId: string,
  workoutId: string,
  ctx?: GarminContext,
): Promise<CardioGarminView> {
  const garmin = ctx ?? defaultGarminContext();
  if (!garmin.enabled) throw new FeatureDisabledError("garmin");
  const rows = await loadCardio(db, userId, workoutId);
  if (!rows) throw new NotFoundError("Séance cardio");
  const { w, c } = rows;
  if (w.status === "done" || w.status === "skipped")
    throw new ValidationError("Cette séance est terminée : rien à envoyer.");

  const spec = specFromRow(w, c);
  const where = and(eq(cardioWorkouts.id, c.id), eq(cardioWorkouts.userId, userId));
  await db
    .update(cardioWorkouts)
    .set({ garminSyncStatus: "pending", lastSyncError: null })
    .where(where);

  let patch: Pick<
    CardioRow,
    "garminSyncStatus" | "garminWorkoutId" | "garminScheduledFor" | "lastSyncError"
  >;
  try {
    const created = await garmin.provider.createWorkout(userId, spec);
    if (created.status === "failed") {
      patch = {
        garminSyncStatus: "failed",
        garminWorkoutId: created.garminWorkoutId || null,
        garminScheduledFor: null,
        lastSyncError: created.message ?? "Garmin a refusé la création de la séance.",
      };
    } else {
      const scheduled = await garmin.provider.scheduleWorkout(
        userId,
        created.garminWorkoutId,
        w.date,
      );
      const failed = scheduled.status === "failed";
      patch = {
        garminSyncStatus: scheduled.status,
        garminWorkoutId: created.garminWorkoutId,
        garminScheduledFor: failed
          ? null
          : (scheduled.scheduledFor ?? (scheduled.status === "synced" ? w.date : null)),
        lastSyncError: failed
          ? (scheduled.message ?? "Garmin a refusé la planification de la séance.")
          : null,
      };
    }
  } catch (err) {
    log.warn("garmin.push_failed", {
      userId,
      workoutId: w.id,
      provider: garmin.provider.name,
      ...errorFields(err),
    });
    patch = {
      garminSyncStatus: "failed",
      garminWorkoutId: c.garminWorkoutId,
      garminScheduledFor: null,
      lastSyncError: describeGarminError(err),
    };
  }
  await db.update(cardioWorkouts).set(patch).where(where);
  log.info("garmin.push", {
    userId,
    workoutId: w.id,
    provider: garmin.provider.name,
    status: patch.garminSyncStatus,
  });
  return toGarminView({ ...c, ...patch }, userId, garmin);
}

/** "Démarrer": the workout is in progress from now on (idempotent when already started). */
export async function startCardioWorkout(
  db: Db,
  userId: string,
  workoutId: string,
  now = new Date(),
): Promise<void> {
  const rows = await loadCardio(db, userId, workoutId);
  if (!rows) throw new NotFoundError("Séance cardio");
  const { w } = rows;
  if (w.status === "in_progress") return;
  if (w.status === "done" || w.status === "skipped")
    throw new ValidationError("Cette séance est déjà terminée.");
  await db
    .update(workouts)
    .set({ status: "in_progress", startAt: now })
    .where(and(eq(workouts.id, w.id), eq(workouts.userId, userId)));
}

/**
 * "Terminer" (spec §22): the actual duration is the elapsed time since "Démarrer" when the workout
 * is in progress, else the planned duration (an explicit value always wins). Delegates to
 * `completeWorkout`; callers run `recompute` afterwards.
 */
export async function completeCardio(
  db: Db,
  userId: string,
  opts: {
    workoutId: string;
    rpe: number | null;
    feeling: Feeling | null;
    painReported: boolean;
    actualDurationMin?: number | null;
    notes?: string;
    now?: Date;
  },
): Promise<{ actualDurationMin: number | null }> {
  const now = opts.now ?? new Date();
  const rows = await loadCardio(db, userId, opts.workoutId);
  if (!rows) throw new NotFoundError("Séance cardio");
  const { w } = rows;
  const elapsedMin =
    w.status === "in_progress" && w.startAt
      ? Math.max(1, Math.round((now.getTime() - w.startAt.getTime()) / 60_000))
      : null;
  const actualDurationMin =
    opts.actualDurationMin ??
    (elapsedMin != null && elapsedMin <= MAX_ELAPSED_MIN ? elapsedMin : null) ??
    w.plannedDurationMin ??
    null;
  await completeWorkout(db, userId, {
    workoutId: w.id,
    rpe: opts.rpe,
    feeling: opts.feeling,
    painReported: opts.painReported,
    actualDurationMin,
    notes: opts.notes,
    finishedAt: now,
  });
  return { actualDurationMin };
}
