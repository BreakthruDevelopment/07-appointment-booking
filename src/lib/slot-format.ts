import { TZDate } from "@date-fns/tz";

/**
 * Pure time helpers for the booking pages (no server-only imports, so client components can use them).
 * Every slot is an absolute UTC instant. These functions only decide how to *show* one in a zone and which
 * local calendar day it belongs to; nothing here decides availability. All arithmetic on days goes through
 * local calendar keys ("2026-11-01") and `TZDate`, so a 23- or 25-hour day is the right length.
 */

const LOCALE = "en-US";

/** Node 20+ prints a narrow no-break space before AM/PM; normalise so output is stable everywhere. */
function plain(text: string): string {
  return text.replace(/[  ]/g, " ");
}

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(LOCALE, { timeZone, ...options });
}

/** The local calendar date (YYYY-MM-DD) of an instant in a zone. */
export function dateKeyInZone(instant: Date | string | number, timeZone: string): string {
  const parts = formatter(timeZone, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** A calendar key shifted by whole days (pure calendar arithmetic, no zone involved). */
export function addDays(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The instant a local calendar day starts in a zone. If midnight doesn't exist (a gap), the first real instant of the day. */
export function dayStart(key: string, timeZone: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(new TZDate(y, m - 1, d, 0, 0, 0, timeZone).getTime());
}

/** `days` consecutive local days starting `offsetDays` after `todayKey`, as a UTC window for the slots API. */
export function dayWindow(todayKey: string, offsetDays: number, days: number, timeZone: string) {
  const first = addDays(todayKey, offsetDays);
  const keys = Array.from({ length: days }, (_, i) => addDays(first, i));
  return { keys, from: dayStart(first, timeZone), to: dayStart(addDays(first, days), timeZone) };
}

/** Slots (ISO strings) grouped by their local day in `timeZone`, each group sorted. */
export function groupByDay(slots: readonly string[], timeZone: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const iso of [...slots].sort()) {
    const key = dateKeyInZone(iso, timeZone);
    const list = groups.get(key);
    if (list) list.push(iso);
    else groups.set(key, [iso]);
  }
  return groups;
}

export function zoneAbbreviation(instant: Date | string, timeZone: string): string {
  const part = formatter(timeZone, { timeZoneName: "short" })
    .formatToParts(new Date(instant))
    .find((p) => p.type === "timeZoneName");
  return part?.value ?? timeZone;
}

function clock(instant: Date | string, timeZone: string, withZone: boolean): string {
  return plain(formatter(timeZone, { hour: "numeric", minute: "2-digit", ...(withZone ? { timeZoneName: "short" } : {}) }).format(new Date(instant)));
}

/**
 * Chip labels for one day's slots. Normally "3:00 PM". When a fall-back day makes two different instants read
 * the same ("1:30 AM" twice), both carry their zone ("1:30 AM EDT", "1:30 AM EST") so they can be told apart.
 */
export function chipLabels(slots: readonly string[], timeZone: string): { iso: string; label: string }[] {
  const plainLabels = slots.map((iso) => clock(iso, timeZone, false));
  const counts = new Map<string, number>();
  for (const label of plainLabels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return slots.map((iso, i) => ({ iso, label: (counts.get(plainLabels[i]) ?? 0) > 1 ? clock(iso, timeZone, true) : plainLabels[i] }));
}

/** "Tue, Nov 17, 3:00 PM MST". */
export function formatDateTime(instant: Date | string, timeZone: string): string {
  return plain(
    formatter(timeZone, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(instant)),
  );
}

/** "Tue, Nov 17" for a local calendar key. */
export function formatDay(key: string): string {
  return formatter("UTC", { weekday: "short", month: "short", day: "numeric" }).format(new Date(`${key}T12:00:00Z`));
}

/** "Tuesday, November 17" for a local calendar key. */
export function formatDayLong(key: string): string {
  return formatter("UTC", { weekday: "long", month: "long", day: "numeric" }).format(new Date(`${key}T12:00:00Z`));
}

/** The pieces of the day-strip button: weekday, day of month, month. */
export function dayParts(key: string): { weekday: string; day: string; month: string } {
  const at = new Date(`${key}T12:00:00Z`);
  return {
    weekday: formatter("UTC", { weekday: "short" }).format(at),
    day: formatter("UTC", { day: "numeric" }).format(at),
    month: formatter("UTC", { month: "short" }).format(at),
  };
}

/** "9:00 AM" for minutes after midnight; 1440 reads "Midnight". */
export function formatMinutes(minutes: number): string {
  if (minutes >= 1440) return "Midnight (24:00)";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** The line under the slot picker: which zone the times are in, and the provider's if it differs. */
export function zoneNote(viewerZone: string, providerZone: string, providerName: string): string {
  const base = `Times shown in your time zone, ${viewerZone}.`;
  return viewerZone === providerZone ? `${base} That is also ${providerName}'s time zone.` : `${base} ${providerName} is in ${providerZone}.`;
}
