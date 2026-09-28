/** Small formatting helpers shared by client and server components (French locale). */
export function formatMinutes(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return "—";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`;
}

export function formatPace(secPerKm: number | null | undefined): string {
  if (!secPerKm || !Number.isFinite(secPerKm)) return "—";
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")} /km`;
}

export function formatDurationSec(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function formatKg(kg: number | null | undefined, digits = 1): string {
  if (kg == null || !Number.isFinite(kg)) return "—";
  return `${Number.isInteger(kg) ? kg : kg.toFixed(digits)} kg`;
}

export function formatKm(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return "—";
  return `${(m / 1000).toFixed(m >= 10000 ? 1 : 2)} km`;
}

const WEEKDAYS_FR = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."];
const MONTHS_FR = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

/** "jeu. 1 oct." from an ISO date, without timezone surprises (date-only arithmetic). */
export function formatDateShort(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const wd = (d.getUTCDay() + 6) % 7;
  return `${WEEKDAYS_FR[wd]} ${d.getUTCDate()} ${MONTHS_FR[d.getUTCMonth()]}`;
}

export function weekdayShort(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return WEEKDAYS_FR[(d.getUTCDay() + 6) % 7] ?? "";
}

export function clockFromMinutes(min: number | null | undefined): string {
  if (min == null) return "";
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}
