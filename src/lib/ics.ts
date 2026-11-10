/**
 * RFC 5545 by hand: just enough iCalendar for one appointment per VEVENT.
 * Pure functions, no I/O, so the output is easy to test against a real parser.
 *
 * - Lines end in CRLF and are folded at 75 octets (never inside a UTF-8 character).
 * - TEXT values escape `\`, `;`, `,` and newlines; other control characters are dropped, so a name or
 *   note can never start a new property line.
 * - UID is stable (`<booking id>@<domain>`); SEQUENCE is the booking's `sequence`, bumped on cancel;
 *   DTSTAMP is the booking's `updatedAt`, so the same row always renders the same bytes.
 * - A cancelled booking is still published, with STATUS:CANCELLED and the higher SEQUENCE, so a calendar
 *   that already imported it replaces it. (METHOD stays PUBLISH: METHOD:CANCEL is an iTIP scheduling
 *   message that needs an ORGANIZER address, and we don't publish anyone's email.)
 */

/** Fixed, so a booking's UID doesn't change between the run.app URL and the custom domain. */
export const ICS_UID_DOMAIN = "app7.breakthruventures.ai";
export const ICS_PRODID = "-//Breakthru Ventures//Appointment Booking//EN";
export const ICS_CONTENT_TYPE = "text/calendar; charset=utf-8";

export type IcsEvent = {
  id: string;
  startsAt: Date;
  endsAt: Date;
  summary: string;
  description?: string;
  status: "confirmed" | "cancelled";
  sequence: number;
  /** DTSTAMP; use the row's `updatedAt` for a deterministic file. */
  stamp: Date;
};

export type IcsCalendar = {
  /** X-WR-CALNAME, shown by Google and Apple Calendar for subscribed feeds. */
  name?: string;
  method?: "PUBLISH";
  events: IcsEvent[];
};

/** Escape a TEXT value (RFC 5545 section 3.3.11). */
export function escapeText(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, "\n")
    // Drop controls other than the newline we just normalised (tab included: it's never useful here).
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** `20261102T153000Z`. */
export function formatUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Fold one logical line to at most 75 octets per physical line; continuation lines start with one space. */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let used = 0;
  let limit = 75; // continuation lines carry a leading space, so they have 74 left
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (used + size > limit) {
      out.push(current);
      current = " ";
      used = 1;
      limit = 75;
    }
    current += char;
    used += size;
  }
  out.push(current);
  return out.join("\r\n");
}

function eventLines(event: IcsEvent): string[] {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${event.id}@${ICS_UID_DOMAIN}`,
    `DTSTAMP:${formatUtc(event.stamp)}`,
    `DTSTART:${formatUtc(event.startsAt)}`,
    `DTEND:${formatUtc(event.endsAt)}`,
    `SEQUENCE:${Math.max(0, Math.trunc(event.sequence))}`,
    `STATUS:${event.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
    "TRANSP:OPAQUE",
    `SUMMARY:${escapeText(event.summary)}`,
  ];
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  lines.push("END:VEVENT");
  return lines;
}

/** A complete VCALENDAR document, CRLF-terminated. */
export function buildCalendar(calendar: IcsCalendar): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:${ICS_PRODID}`, "CALSCALE:GREGORIAN", `METHOD:${calendar.method ?? "PUBLISH"}`];
  if (calendar.name) {
    lines.push(`X-WR-CALNAME:${escapeText(calendar.name)}`);
    lines.push("REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H");
  }
  for (const event of calendar.events) lines.push(...eventLines(event));
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** Headers shared by every .ics response: private, never cached by shared caches, never indexed. */
export function icsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": ICS_CONTENT_TYPE,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
    "referrer-policy": "no-referrer",
    ...extra,
  };
}
