import "server-only";
import { TZDate } from "@date-fns/tz";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { BadRequestError } from "@/lib/errors";

/** Starts are offered on this grid, measured from each working-interval start. */
export const SLOT_STEP_MIN = 15;
/** Public slot queries refuse a wider window than this. */
export const MAX_QUERY_MS = 14 * 24 * 60 * 60 * 1000;
/** Hard cap so one response can't list an entire horizon at a fine step. */
export const MAX_SLOTS = 200;

export type WeeklyHour = { weekday: number; startMin: number; endMin: number };
export type DateOverrideInput = { date: string; closed: boolean; intervals: { start: number; end: number }[] };
export type BusyRange = { start: Date; end: Date };

export type AvailabilityProfile = {
  timeZone: string;
  accepting: boolean;
  minNoticeMinutes: number;
  horizonDays: number;
};

export type AvailabilityService = {
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  active: boolean;
};

export type AvailabilityInput = {
  profile: AvailabilityProfile;
  service: AvailabilityService;
  hours: WeeklyHour[];
  overrides: DateOverrideInput[];
  busy: BusyRange[];
  from: Date;
  to: Date;
  now: Date;
};

export type Slot = { start: Date };

const slotWindow = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
});

/** `from`/`to` are UTC instants. The span is at most 14 days, `to` strictly after `from`. */
export function parseSlotWindow(fromRaw: string | null, toRaw: string | null): { from: Date; to: Date } {
  const result = slotWindow.safeParse({ from: fromRaw ?? "", to: toRaw ?? "" });
  if (!result.success) throw new BadRequestError("from and to must be ISO 8601 date-times with a Z or an offset.");
  const parsed = result.data;
  const from = new Date(parsed.from);
  const to = new Date(parsed.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new BadRequestError("from and to must be UTC instants.");
  }
  if (to.getTime() <= from.getTime()) throw new BadRequestError("to must be after from.");
  if (to.getTime() - from.getTime() > MAX_QUERY_MS) {
    throw new BadRequestError("Slot queries can span at most 14 days.");
  }
  return { from, to };
}

export function todayInZone(timeZone: string, now: Date): string {
  return formatYmd(new TZDate(now.getTime(), timeZone));
}

/**
 * Open starts for one service. Weekly hours and overrides are wall-clock minutes in the provider's
 * zone. A local start that doesn't exist (spring-forward gap) is skipped. An ambiguous start
 * (fall-back) uses the first occurrence. Duration and buffers are absolute minutes, so a slot that
 * crosses a DST change is still `durationMin` long, and buffers may sit outside working hours.
 * A candidate is removed when `[start − bufferBefore, end + bufferAfter)` overlaps any busy range.
 * Starts must be `>= now + minNotice` and `< now + horizonDays`, inside `[from, to)`, and at most 200.
 */
export function availableSlots(input: AvailabilityInput): Slot[] {
  const { profile, service, hours, overrides, busy, from, to, now } = input;
  if (!profile.accepting || !service.active) return [];
  if (!(to.getTime() > from.getTime())) return [];

  const earliest = now.getTime() + profile.minNoticeMinutes * 60_000;
  const latest = now.getTime() + profile.horizonDays * 86_400_000;
  const byDate = new Map(overrides.map((o) => [o.date, o]));
  const found: Date[] = [];

  for (const date of localDatesCovering(from, to, profile.timeZone)) {
    const override = byDate.get(date);
    const intervals = override
      ? override.closed
        ? []
        : override.intervals.map((i) => ({ startMin: i.start, endMin: i.end }))
      : hours.filter((h) => h.weekday === isoWeekday(date, profile.timeZone));

    for (const interval of intervals) {
      const intervalEnd = zonedEndInstant(date, interval.endMin, profile.timeZone);
      if (!intervalEnd) continue;
      for (let minute = interval.startMin; minute < interval.endMin; minute += SLOT_STEP_MIN) {
        const start = zonedInstant(date, minute, profile.timeZone);
        if (!start) continue;
        const startMs = start.getTime();
        const endMs = startMs + service.durationMin * 60_000;
        if (endMs > intervalEnd.getTime()) continue;
        if (startMs < from.getTime() || startMs >= to.getTime()) continue;
        if (startMs < earliest || startMs >= latest) continue;
        const blockedStart = startMs - service.bufferBeforeMin * 60_000;
        const blockedEnd = endMs + service.bufferAfterMin * 60_000;
        const overlaps = busy.some((b) => blockedStart < b.end.getTime() && b.start.getTime() < blockedEnd);
        if (overlaps) continue;
        found.push(start);
      }
    }
  }

  found.sort((a, b) => a.getTime() - b.getTime());
  const unique: Date[] = [];
  for (const start of found) {
    if (unique.length > 0 && unique[unique.length - 1].getTime() === start.getTime()) continue;
    unique.push(start);
    if (unique.length === MAX_SLOTS) break;
  }
  return unique.map((start) => ({ start }));
}

type Loaded = {
  profile: AvailabilityProfile;
  service: AvailabilityService;
  hours: WeeklyHour[];
  overrides: DateOverrideInput[];
  busy: BusyRange[];
};

/**
 * Profile, service, hours, overrides, and confirmed blocked ranges in one statement.
 * Returns null when that provider doesn't offer that service.
 */
export async function loadAvailability(providerId: string, serviceId: string, from: Date, to: Date): Promise<Loaded | null> {
  return loadWhere(sql`p.user_id = ${providerId}`, serviceId, from, to);
}

/** Same as `loadAvailability`, looked up by the public slug so the slots route is one round trip. */
export async function loadAvailabilityBySlug(slug: string, serviceId: string, from: Date, to: Date): Promise<Loaded | null> {
  return loadWhere(sql`p.slug = ${slug}`, serviceId, from, to);
}

async function loadWhere(where: ReturnType<typeof sql>, serviceId: string, from: Date, to: Date): Promise<Loaded | null> {
  const rows = await db().execute<LoadRow>(sql`
    select
      p.time_zone,
      p.accepting,
      p.min_notice_minutes,
      p.horizon_days,
      s.duration_min,
      s.buffer_before_min,
      s.buffer_after_min,
      s.active,
      coalesce((
        select json_agg(json_build_object('weekday', h.weekday, 'startMin', h.start_min, 'endMin', h.end_min))
        from weekly_hours h
        where h.provider_id = p.user_id
      ), '[]'::json) as hours,
      coalesce((
        select json_agg(json_build_object('date', o.date, 'closed', o.closed, 'intervals', o.intervals))
        from date_override o
        where o.provider_id = p.user_id
      ), '[]'::json) as overrides,
      coalesce((
        select json_agg(json_build_object('start', lower(b.blocked), 'end', upper(b.blocked)))
        from booking b
        where b.provider_id = p.user_id
          and b.status = 'confirmed'
          and b.blocked && tstzrange(
            ${from.toISOString()}::timestamptz - make_interval(mins => s.buffer_before_min),
            ${to.toISOString()}::timestamptz + make_interval(mins => s.duration_min + s.buffer_after_min),
            '[)'
          )
      ), '[]'::json) as busy
    from provider_profile p
    join service s on s.provider_id = p.user_id and s.id = ${serviceId}::uuid
    where ${where}
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    profile: {
      timeZone: row.time_zone,
      accepting: row.accepting,
      minNoticeMinutes: Number(row.min_notice_minutes),
      horizonDays: Number(row.horizon_days),
    },
    service: {
      durationMin: Number(row.duration_min),
      bufferBeforeMin: Number(row.buffer_before_min),
      bufferAfterMin: Number(row.buffer_after_min),
      active: row.active,
    },
    hours: asArray<WeeklyHour>(row.hours),
    overrides: asArray<DateOverrideInput>(row.overrides).map((o) => ({
      date: String(o.date).slice(0, 10),
      closed: Boolean(o.closed),
      intervals: Array.isArray(o.intervals) ? o.intervals : [],
    })),
    busy: asArray<{ start: string | Date; end: string | Date }>(row.busy).map((b) => ({
      start: new Date(b.start),
      end: new Date(b.end),
    })),
  };
}

type LoadRow = {
  time_zone: string;
  accepting: boolean;
  min_notice_minutes: number;
  horizon_days: number;
  duration_min: number;
  buffer_before_min: number;
  buffer_after_min: number;
  active: boolean;
  hours: unknown;
  overrides: unknown;
  busy: unknown;
};

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Wall-clock `minutes` on `date` in `timeZone`, as an absolute instant.
 * Null when that local time falls in a spring-forward gap. Ambiguous fall-back times
 * resolve to the earlier instant. `minutes` may be 1440 (next local midnight).
 */
function zonedInstant(date: string, minutes: number, timeZone: string): Date | null {
  const [y0, m0, d0] = date.split("-").map(Number);
  if (!y0 || !m0 || !d0) return null;
  const extraDays = Math.floor(minutes / 1440);
  const mins = minutes - extraDays * 1440;
  const anchor = new TZDate(y0, m0 - 1, d0 + extraDays, 12, 0, 0, timeZone);
  const y = anchor.getFullYear();
  const month = anchor.getMonth();
  const day = anchor.getDate();
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  const z = new TZDate(y, month, day, hh, mm, 0, timeZone);
  if (z.getFullYear() !== y || z.getMonth() !== month || z.getDate() !== day || z.getHours() !== hh || z.getMinutes() !== mm) {
    return null;
  }
  let earliest = z.getTime();
  for (const backMin of [30, 60]) {
    const earlier = new TZDate(z.getTime() - backMin * 60_000, timeZone);
    if (
      earlier.getFullYear() === y &&
      earlier.getMonth() === month &&
      earlier.getDate() === day &&
      earlier.getHours() === hh &&
      earlier.getMinutes() === mm &&
      earlier.getTime() < earliest
    ) {
      earliest = earlier.getTime();
    }
  }
  return new Date(earliest);
}

/**
 * Like `zonedInstant`, for the END of a working interval. An end inside a spring-forward gap (or at
 * a midnight that doesn't exist, as in America/Santiago) resolves to the first instant after the
 * transition instead of dropping the whole interval.
 */
function zonedEndInstant(date: string, minutes: number, timeZone: string): Date | null {
  for (let extra = 0; extra <= 240; extra++) {
    const resolved = zonedInstant(date, minutes + extra, timeZone);
    if (resolved) return resolved;
  }
  return null;
}

function isoWeekday(date: string, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const z = new TZDate(y, m - 1, d, 12, 0, 0, timeZone);
  const day = z.getDay();
  return day === 0 ? 7 : day;
}

function localDatesCovering(from: Date, to: Date, timeZone: string): string[] {
  if (to.getTime() <= from.getTime()) return [];
  const start = new TZDate(from.getTime(), timeZone);
  const end = new TZDate(to.getTime() - 1, timeZone);
  const last = formatYmd(end);
  const dates: string[] = [];
  let y = start.getFullYear();
  let m = start.getMonth();
  let d = start.getDate();
  for (let i = 0; i < 20; i++) {
    const key = formatParts(y, m, d);
    dates.push(key);
    if (key >= last) break;
    const next = new TZDate(y, m, d + 1, 12, 0, 0, timeZone);
    y = next.getFullYear();
    m = next.getMonth();
    d = next.getDate();
  }
  return dates;
}

function formatYmd(z: TZDate): string {
  return formatParts(z.getFullYear(), z.getMonth(), z.getDate());
}

function formatParts(y: number, monthIndex: number, d: number): string {
  return `${y}-${String(monthIndex + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
