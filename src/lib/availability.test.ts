import { describe, expect, it } from "vitest";
import { type AvailabilityInput, type Slot, availableSlots, parseSlotWindow } from "@/lib/availability";

const open = (startMin: number, endMin: number) =>
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMin, endMin }));

const iso = (slots: Slot[]) => slots.map((slot) => slot.start.toISOString());

function at(partial: Partial<AvailabilityInput> & Pick<AvailabilityInput, "profile" | "from" | "to" | "now">): AvailabilityInput {
  return {
    service: { durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0, active: true },
    hours: open(9 * 60, 17 * 60),
    overrides: [],
    busy: [],
    ...partial,
  };
}

describe("availableSlots", () => {
  it("skips the America/New_York spring-forward gap and keeps a 60-minute absolute duration", () => {
    const slots = availableSlots(
      at({
        profile: { timeZone: "America/New_York", accepting: true, minNoticeMinutes: 0, horizonDays: 60 },
        hours: open(60, 240),
        from: new Date("2026-03-08T00:00:00Z"),
        to: new Date("2026-03-09T00:00:00Z"),
        now: new Date("2026-03-01T00:00:00Z"),
      }),
    );
    // 01:30 EST + 60 absolute minutes is 03:30 EDT, so 06:30Z is offered. 02:00–02:45 do not exist.
    expect(iso(slots)).toEqual([
      "2026-03-08T06:00:00.000Z",
      "2026-03-08T06:15:00.000Z",
      "2026-03-08T06:30:00.000Z",
      "2026-03-08T06:45:00.000Z",
      "2026-03-08T07:00:00.000Z",
    ]);
  });

  it("keeps an interval whose end is a midnight that doesn't exist (America/Santiago 2026-09-05)", () => {
    const slots = availableSlots(
      at({
        profile: { timeZone: "America/Santiago", accepting: true, minNoticeMinutes: 0, horizonDays: 60 },
        service: { durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, active: true },
        hours: [{ weekday: 6, startMin: 22 * 60, endMin: 24 * 60 }],
        from: new Date("2026-09-05T00:00:00Z"),
        to: new Date("2026-09-06T12:00:00Z"),
        now: new Date("2026-09-01T00:00:00Z"),
      }),
    );
    // 22:00 to 23:30 local (UTC-4), every 15 minutes.
    expect(slots).toHaveLength(7);
    expect(slots[0].start.toISOString()).toBe("2026-09-06T02:00:00.000Z");
    expect(slots[6].start.toISOString()).toBe("2026-09-06T03:30:00.000Z");
  });

  it("ends an interval that finishes inside the America/New_York spring-forward gap at the transition", () => {
    const slots = availableSlots(
      at({
        profile: { timeZone: "America/New_York", accepting: true, minNoticeMinutes: 0, horizonDays: 60 },
        service: { durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, active: true },
        hours: open(60, 150),
        from: new Date("2026-03-08T00:00:00Z"),
        to: new Date("2026-03-09T00:00:00Z"),
        now: new Date("2026-03-01T00:00:00Z"),
      }),
    );
    // 01:00, 01:15, 01:30 EST. A 01:45 start would run past the 03:00 EDT transition.
    expect(iso(slots)).toEqual(["2026-03-08T06:00:00.000Z", "2026-03-08T06:15:00.000Z", "2026-03-08T06:30:00.000Z"]);
  });

  it("uses the first occurrence of an ambiguous America/New_York fall-back time", () => {
    const slots = availableSlots(
      at({
        profile: { timeZone: "America/New_York", accepting: true, minNoticeMinutes: 0, horizonDays: 60 },
        hours: open(60, 180),
        from: new Date("2026-11-01T00:00:00Z"),
        to: new Date("2026-11-02T00:00:00Z"),
        now: new Date("2026-10-01T00:00:00Z"),
      }),
    );
    expect(iso(slots)).toContain("2026-11-01T05:00:00.000Z");
    expect(iso(slots)).not.toContain("2026-11-01T06:00:00.000Z");
  });

  it("skips the Europe/London spring-forward gap", () => {
    const slots = availableSlots(
      at({
        profile: { timeZone: "Europe/London", accepting: true, minNoticeMinutes: 0, horizonDays: 60 },
        hours: open(0, 240),
        from: new Date("2026-03-29T00:00:00Z"),
        to: new Date("2026-03-29T04:00:00Z"),
        now: new Date("2026-03-01T00:00:00Z"),
      }),
    );
    expect(iso(slots)).toEqual([
      "2026-03-29T00:00:00.000Z",
      "2026-03-29T00:15:00.000Z",
      "2026-03-29T00:30:00.000Z",
      "2026-03-29T00:45:00.000Z",
      "2026-03-29T01:00:00.000Z",
      "2026-03-29T01:15:00.000Z",
      "2026-03-29T01:30:00.000Z",
      "2026-03-29T01:45:00.000Z",
      "2026-03-29T02:00:00.000Z",
    ]);
  });

  it("uses the first occurrence of an ambiguous Europe/London fall-back time", () => {
    const slots = availableSlots(
      at({
        profile: { timeZone: "Europe/London", accepting: true, minNoticeMinutes: 0, horizonDays: 60 },
        hours: open(60, 180),
        from: new Date("2026-10-24T22:00:00Z"),
        to: new Date("2026-10-25T04:00:00Z"),
        now: new Date("2026-10-01T00:00:00Z"),
      }),
    );
    expect(iso(slots)).toContain("2026-10-25T00:00:00.000Z");
    expect(iso(slots)).not.toContain("2026-10-25T01:00:00.000Z");
  });

  it("skips Australia/Lord_Howe's 30-minute spring-forward gap", () => {
    const slots = availableSlots(
      at({
        profile: { timeZone: "Australia/Lord_Howe", accepting: true, minNoticeMinutes: 0, horizonDays: 60 },
        service: { durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, active: true },
        hours: open(90, 210),
        from: new Date("2026-10-03T14:00:00Z"),
        to: new Date("2026-10-03T18:00:00Z"),
        now: new Date("2026-09-01T00:00:00Z"),
      }),
    );
    const starts = iso(slots);
    expect(starts).toContain("2026-10-03T15:15:00.000Z");
    expect(starts).toContain("2026-10-03T15:30:00.000Z");
    expect(starts).not.toContain("2026-10-03T15:20:00.000Z");
    expect(starts.filter((s) => s === "2026-10-03T15:30:00.000Z")).toHaveLength(1);
  });

  it("uses the first occurrence of Australia/Lord_Howe's 30-minute fall-back", () => {
    const slots = availableSlots(
      at({
        profile: { timeZone: "Australia/Lord_Howe", accepting: true, minNoticeMinutes: 0, horizonDays: 60 },
        service: { durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, active: true },
        hours: open(60, 180),
        from: new Date("2026-04-04T13:00:00Z"),
        to: new Date("2026-04-04T18:00:00Z"),
        now: new Date("2026-03-01T00:00:00Z"),
      }),
    );
    expect(iso(slots)).toContain("2026-04-04T14:30:00.000Z");
    expect(iso(slots)).not.toContain("2026-04-04T15:00:00.000Z");
  });

  it("places Asia/Kolkata slots at UTC+5:30 with no DST shift", () => {
    const slots = availableSlots(
      at({
        profile: { timeZone: "Asia/Kolkata", accepting: true, minNoticeMinutes: 0, horizonDays: 60 },
        service: { durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, active: true },
        hours: open(9 * 60, 10 * 60),
        from: new Date("2026-06-15T00:00:00Z"),
        to: new Date("2026-06-16T00:00:00Z"),
        now: new Date("2026-06-01T00:00:00Z"),
      }),
    );
    expect(iso(slots)).toEqual(["2026-06-15T03:30:00.000Z", "2026-06-15T03:45:00.000Z", "2026-06-15T04:00:00.000Z"]);
  });

  it("keeps a gap of one booking's after-buffer plus the next booking's before-buffer", () => {
    const slots = availableSlots(
      at({
        profile: { timeZone: "UTC", accepting: true, minNoticeMinutes: 0, horizonDays: 30 },
        service: { durationMin: 60, bufferBeforeMin: 15, bufferAfterMin: 15, active: true },
        hours: open(8 * 60, 18 * 60),
        busy: [{ start: new Date("2026-06-15T09:00:00.000Z"), end: new Date("2026-06-15T10:15:00.000Z") }],
        from: new Date("2026-06-15T00:00:00Z"),
        to: new Date("2026-06-16T00:00:00Z"),
        now: new Date("2026-06-01T00:00:00Z"),
      }),
    );
    const starts = iso(slots);
    expect(starts).not.toContain("2026-06-15T10:15:00.000Z");
    expect(starts).toContain("2026-06-15T10:30:00.000Z");
  });

  it("lets buffers extend outside working hours", () => {
    const slots = availableSlots(
      at({
        profile: { timeZone: "UTC", accepting: true, minNoticeMinutes: 0, horizonDays: 30 },
        service: { durationMin: 60, bufferBeforeMin: 15, bufferAfterMin: 15, active: true },
        hours: open(9 * 60, 12 * 60),
        from: new Date("2026-06-15T00:00:00Z"),
        to: new Date("2026-06-16T00:00:00Z"),
        now: new Date("2026-06-01T00:00:00Z"),
      }),
    );
    expect(iso(slots)).toContain("2026-06-15T09:00:00.000Z");
  });

  it("drops starts inside the minimum notice and keeps the one on the boundary", () => {
    const slots = availableSlots(
      at({
        profile: { timeZone: "UTC", accepting: true, minNoticeMinutes: 60, horizonDays: 30 },
        service: { durationMin: 15, bufferBeforeMin: 0, bufferAfterMin: 0, active: true },
        hours: open(0, 1440),
        from: new Date("2026-06-15T12:00:00Z"),
        to: new Date("2026-06-15T14:00:00Z"),
        now: new Date("2026-06-15T12:00:00Z"),
      }),
    );
    const starts = iso(slots);
    expect(starts).not.toContain("2026-06-15T12:45:00.000Z");
    expect(starts).toContain("2026-06-15T13:00:00.000Z");
  });

  it("drops starts at or after the horizon", () => {
    const slots = availableSlots(
      at({
        profile: { timeZone: "UTC", accepting: true, minNoticeMinutes: 0, horizonDays: 1 },
        service: { durationMin: 15, bufferBeforeMin: 0, bufferAfterMin: 0, active: true },
        hours: open(0, 1440),
        from: new Date("2026-06-16T11:00:00Z"),
        to: new Date("2026-06-16T13:00:00Z"),
        now: new Date("2026-06-15T12:00:00Z"),
      }),
    );
    const starts = iso(slots);
    expect(starts).toContain("2026-06-16T11:45:00.000Z");
    expect(starts).not.toContain("2026-06-16T12:00:00.000Z");
  });

  it("lets an override close a day or replace that day's hours", () => {
    const profile = { timeZone: "UTC", accepting: true, minNoticeMinutes: 0, horizonDays: 30 };
    const closed = availableSlots(
      at({
        profile,
        hours: open(9 * 60, 12 * 60),
        overrides: [{ date: "2026-06-15", closed: true, intervals: [] }],
        from: new Date("2026-06-15T00:00:00Z"),
        to: new Date("2026-06-17T00:00:00Z"),
        now: new Date("2026-06-01T00:00:00Z"),
      }),
    );
    expect(iso(closed).some((start) => start.startsWith("2026-06-15"))).toBe(false);
    expect(iso(closed)).toContain("2026-06-16T09:00:00.000Z");

    const replaced = availableSlots(
      at({
        profile,
        service: { durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, active: true },
        hours: open(9 * 60, 12 * 60),
        overrides: [{ date: "2026-06-15", closed: false, intervals: [{ start: 13 * 60, end: 14 * 60 }] }],
        from: new Date("2026-06-15T00:00:00Z"),
        to: new Date("2026-06-16T00:00:00Z"),
        now: new Date("2026-06-01T00:00:00Z"),
      }),
    );
    expect(iso(replaced)).toEqual([
      "2026-06-15T13:00:00.000Z",
      "2026-06-15T13:15:00.000Z",
      "2026-06-15T13:30:00.000Z",
    ]);
  });

  it("returns at most 200 slots, earliest first", () => {
    const slots = availableSlots(
      at({
        profile: { timeZone: "UTC", accepting: true, minNoticeMinutes: 0, horizonDays: 60 },
        service: { durationMin: 15, bufferBeforeMin: 0, bufferAfterMin: 0, active: true },
        hours: open(0, 1440),
        from: new Date("2026-06-01T00:00:00Z"),
        to: new Date("2026-06-04T00:00:00Z"),
        now: new Date("2026-05-01T00:00:00Z"),
      }),
    );
    expect(slots).toHaveLength(200);
    expect(slots[0].start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(slots[199].start.toISOString()).toBe("2026-06-03T01:45:00.000Z");
  });

  it("returns nothing when the provider is not accepting or the service is inactive", () => {
    const base = {
      from: new Date("2026-06-15T00:00:00Z"),
      to: new Date("2026-06-16T00:00:00Z"),
      now: new Date("2026-06-01T00:00:00Z"),
    };
    expect(availableSlots(at({ ...base, profile: { timeZone: "UTC", accepting: false, minNoticeMinutes: 0, horizonDays: 30 } }))).toEqual([]);
    expect(
      availableSlots(
        at({
          ...base,
          profile: { timeZone: "UTC", accepting: true, minNoticeMinutes: 0, horizonDays: 30 },
          service: { durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0, active: false },
        }),
      ),
    ).toEqual([]);
  });
});

describe("parseSlotWindow", () => {
  it("accepts a 14-day span and refuses anything wider", () => {
    const from = "2026-06-01T00:00:00.000Z";
    const to = new Date(Date.parse(from) + 14 * 24 * 60 * 60 * 1000).toISOString();
    expect(parseSlotWindow(from, to).to.toISOString()).toBe(to);
    expect(() => parseSlotWindow(from, new Date(Date.parse(to) + 1).toISOString())).toThrow(/14 days/);
    expect(() => parseSlotWindow(from, from)).toThrow(/after from/);
    expect(() => parseSlotWindow(null, to)).toThrow();
  });

  it("takes only ISO 8601 date-times with Z or an offset", () => {
    expect(parseSlotWindow("2026-06-01T00:00:00Z", "2026-06-02T00:00:00+02:00").to.toISOString()).toBe("2026-06-01T22:00:00.000Z");
    for (const bad of ["June 1 2026", "2026-06-01", "1780000000000", "2026-06-01T00:00:00", "tomorrow"]) {
      expect(() => parseSlotWindow(bad, "2026-06-02T00:00:00Z"), bad).toThrow(/ISO 8601/);
    }
  });
});
