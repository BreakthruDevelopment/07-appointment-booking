import { z } from "zod";
import { BadRequestError } from "@/lib/errors";

export const MAX_SERVICES = 20;
export const MAX_HOUR_ROWS = 50;
export const MAX_INTERVALS_PER_DAY = 3;
export const MAX_FUTURE_OVERRIDES = 60;

/** Slugs that would collide with app routes or read like system paths. */
export const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "app",
  "auth",
  "bookings",
  "calendar",
  "dashboard",
  "demo",
  "health",
  "me",
  "new",
  "null",
  "p",
  "provider",
  "public",
  "settings",
  "sign-in",
  "signin",
  "static",
  "www",
]);

// Intl.supportedValuesOf("timeZone") only lists canonical names and omits valid
// IANA zones such as "UTC" or "US/Eastern", so ask the Intl engine directly.
export function isKnownZone(timeZone: string): boolean {
  if (timeZone.length < 1 || timeZone.length > 80) return false;
  if (!/^[A-Za-z0-9_+\-/]+$/.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const slug = z
  .string()
  .trim()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, "Use 3–40 lowercase letters, numbers, or hyphens, starting and ending with a letter or number.")
  .refine((value) => !value.includes("--"), "Hyphens can't be doubled.");

export const profileInput = z.object({
  slug,
  displayName: z.string().trim().min(1, "Name is required").max(80),
  bio: z.string().trim().max(500).default(""),
  timeZone: z.string().trim().min(1).max(80),
  accepting: z.boolean(),
  minNoticeMinutes: z.number().int().min(0).max(10_080),
  horizonDays: z.number().int().min(1).max(60),
});

export const serviceInput = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1, "Name is required").max(80),
  description: z.string().trim().max(500).default(""),
  durationMin: z
    .number()
    .int()
    .min(15)
    .max(240)
    .refine((n) => n % 5 === 0, "Duration must be a multiple of 5 minutes."),
  bufferBeforeMin: z.number().int().min(0).max(60).default(0),
  bufferAfterMin: z.number().int().min(0).max(60).default(0),
  active: z.boolean().default(true),
  position: z.number().int().min(0).max(10_000).optional(),
});

const hourRow = z.object({
  weekday: z.number().int().min(1).max(7),
  startMin: z.number().int(),
  endMin: z.number().int(),
});

export const hoursInput = z.object({
  hours: z.array(hourRow).max(MAX_HOUR_ROWS),
});

const wall = z.object({
  start: z.number().int(),
  end: z.number().int(),
});

export const overridesInput = z.object({
  overrides: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Dates are YYYY-MM-DD."),
        closed: z.boolean(),
        intervals: z.array(wall).max(MAX_INTERVALS_PER_DAY).default([]),
      }),
    )
    .max(200),
});

export type ProfileInput = z.infer<typeof profileInput>;
export type ServiceInput = z.infer<typeof serviceInput>;
export type HoursInput = z.infer<typeof hoursInput>;
export type OverridesInput = z.infer<typeof overridesInput>;

type Span = { startMin: number; endMin: number };

/** Null when the weekly-hour set is allowed. Overlaps and the per-day cap are refused here. */
export function hourProblems(hours: (Span & { weekday: number })[]): string | null {
  if (hours.length > MAX_HOUR_ROWS) return "A provider can have at most 50 opening-hour rows.";
  const grouped = new Map<number, Span[]>();
  for (const hour of hours) {
    const problem = spanProblem(hour.startMin, hour.endMin);
    if (problem) return problem;
    const list = grouped.get(hour.weekday) ?? [];
    list.push(hour);
    grouped.set(hour.weekday, list);
  }
  for (const list of grouped.values()) {
    const overlap = overlapProblem(list);
    if (overlap) return overlap;
  }
  return null;
}

export function intervalProblems(intervals: { start: number; end: number }[]): string | null {
  const spans = intervals.map((i) => ({ startMin: i.start, endMin: i.end }));
  for (const span of spans) {
    const problem = spanProblem(span.startMin, span.endMin);
    if (problem) return problem;
  }
  return overlapProblem(spans);
}

function spanProblem(startMin: number, endMin: number): string | null {
  if (startMin < 0 || endMin > 1440 || startMin >= endMin || startMin % 15 !== 0 || endMin % 15 !== 0) {
    return "Hours must start before they end, on 15-minute marks, between 00:00 and 24:00.";
  }
  return null;
}

function overlapProblem(spans: Span[]): string | null {
  if (spans.length > MAX_INTERVALS_PER_DAY) return "At most 3 opening intervals per day.";
  const sorted = [...spans].sort((a, b) => a.startMin - b.startMin);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startMin < sorted[i - 1].endMin) return "Opening hours on the same day can't overlap.";
  }
  return null;
}

export function isRealDate(iso: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function parseProfile(input: unknown): ProfileInput {
  const data = profileInput.parse(input);
  if (RESERVED_SLUGS.has(data.slug)) throw new BadRequestError("That link is reserved.");
  if (!isKnownZone(data.timeZone)) throw new BadRequestError("Unknown time zone.");
  return data;
}

export function parseService(input: unknown): ServiceInput {
  return serviceInput.parse(input);
}

export function parseHours(input: unknown): HoursInput {
  const data = hoursInput.parse(input);
  const problem = hourProblems(data.hours);
  if (problem) throw new BadRequestError(problem);
  return data;
}

export function parseOverrides(input: unknown, today: string): OverridesInput {
  const data = overridesInput.parse(input);
  const seen = new Set<string>();
  let future = 0;
  for (const row of data.overrides) {
    if (!isRealDate(row.date)) throw new BadRequestError("Override dates must be real calendar dates.");
    if (seen.has(row.date)) throw new BadRequestError("Each date can have only one override.");
    seen.add(row.date);
    if (row.date >= today) future += 1;
    if (!row.closed) {
      const problem = intervalProblems(row.intervals);
      if (problem) throw new BadRequestError(problem);
    }
  }
  if (future > MAX_FUTURE_OVERRIDES) {
    throw new BadRequestError("At most 60 future date overrides.");
  }
  return data;
}
