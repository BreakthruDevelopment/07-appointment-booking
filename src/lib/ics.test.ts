import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import { ICS_UID_DOMAIN, buildCalendar, escapeText, foldLine, formatUtc, icsHeaders } from "@/lib/ics";

const base = {
  id: "7f1d3a52-0c1e-4f7a-9d52-0d6f1a6f9b11",
  startsAt: new Date("2026-11-03T16:30:00.000Z"),
  endsAt: new Date("2026-11-03T17:00:00.000Z"),
  summary: "Haircut with Demo Studio",
  status: "confirmed" as const,
  sequence: 0,
  stamp: new Date("2026-11-01T12:00:00.000Z"),
};

function parse(text: string) {
  const root = new ICAL.Component(ICAL.parse(text));
  return { root, events: root.getAllSubcomponents("vevent") };
}

describe("ics", () => {
  it("escapes backslash, semicolon, comma and newlines, and drops other control characters", () => {
    expect(escapeText("a\\b;c,d\r\ne\nf\rg\u0000h\ti")).toBe("a\\\\b\\;c\\,d\\ne\\nf\\nghi");
  });

  it("formats UTC instants without separators", () => {
    expect(formatUtc(new Date("2026-03-08T09:05:07.123Z"))).toBe("20260308T090507Z");
  });

  it("folds at 75 octets and never splits a multi-byte character", () => {
    const line = "SUMMARY:" + "é".repeat(100) + "😀".repeat(30);
    const folded = foldLine(line);
    const physical = folded.split("\r\n");
    expect(physical.length).toBeGreaterThan(2);
    for (const part of physical) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    for (const part of physical.slice(1)) expect(part.startsWith(" ")).toBe(true);
    // Unfolding gives back the original.
    expect(folded.replace(/\r\n /g, "")).toBe(line);
    expect(foldLine("short")).toBe("short");
  });

  it("emits CRLF line endings only, ending with a CRLF", () => {
    const text = buildCalendar({ events: [base] });
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("parses with ical.js: stable UID, UTC times, status and sequence", () => {
    const { root, events } = parse(buildCalendar({ events: [base] }));
    expect(root.getFirstPropertyValue("version")).toBe("2.0");
    expect(root.getFirstPropertyValue("method")).toBe("PUBLISH");
    expect(events).toHaveLength(1);
    const event = new ICAL.Event(events[0]);
    expect(event.uid).toBe(`${base.id}@${ICS_UID_DOMAIN}`);
    expect(event.startDate.toJSDate().toISOString()).toBe(base.startsAt.toISOString());
    expect(event.endDate.toJSDate().toISOString()).toBe(base.endsAt.toISOString());
    expect(event.summary).toBe(base.summary);
    expect(events[0].getFirstPropertyValue("status")).toBe("CONFIRMED");
    expect(events[0].getFirstPropertyValue("sequence")).toBe(0);
    // Same input, same bytes: the UID and stamp don't drift between downloads.
    expect(buildCalendar({ events: [base] })).toBe(buildCalendar({ events: [base] }));
  });

  it("publishes a cancelled booking with STATUS:CANCELLED, the same UID and a higher SEQUENCE", () => {
    const { events } = parse(buildCalendar({ events: [{ ...base, status: "cancelled", sequence: 1 }] }));
    expect(events[0].getFirstPropertyValue("status")).toBe("CANCELLED");
    expect(events[0].getFirstPropertyValue("sequence")).toBe(1);
    expect(events[0].getFirstPropertyValue("uid")).toBe(`${base.id}@${ICS_UID_DOMAIN}`);
  });

  it("round-trips hostile text and cannot inject properties or events", () => {
    const evil = "x\r\nATTENDEE:mailto:evil@example.test\r\nEND:VEVENT\r\nBEGIN:VEVENT; a,b \\ é 😀";
    const { events } = parse(buildCalendar({ name: evil, events: [{ ...base, summary: evil, description: evil }] }));
    expect(events).toHaveLength(1);
    expect(events[0].getFirstProperty("attendee")).toBeNull();
    expect(events[0].getFirstPropertyValue("summary")).toBe(evil.replace(/\r\n/g, "\n"));
    expect(events[0].getFirstPropertyValue("description")).toBe(evil.replace(/\r\n/g, "\n"));
  });

  it("marks responses private, uncacheable and unindexable, as text/calendar", () => {
    const headers = icsHeaders();
    expect(headers["content-type"]).toBe("text/calendar; charset=utf-8");
    expect(headers["cache-control"]).toContain("no-store");
    expect(headers["x-robots-tag"]).toContain("noindex");
    expect(headers["referrer-policy"]).toBe("no-referrer");
  });
});
