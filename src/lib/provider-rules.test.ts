import { describe, expect, it } from "vitest";
import { hourProblems, intervalProblems, parseOverrides, parseProfile } from "@/lib/provider-rules";

const row = (weekday: number, startMin: number, endMin: number) => ({ weekday, startMin, endMin });

describe("hour and override rules", () => {
  it("refuses overlapping hours and a fourth interval on one day", () => {
    expect(hourProblems([row(1, 9 * 60, 12 * 60), row(1, 11 * 60, 13 * 60)])).toMatch(/overlap/);
    expect(hourProblems([row(1, 9 * 60, 12 * 60), row(1, 12 * 60, 13 * 60)])).toBeNull();
    expect(
      hourProblems([
        row(2, 8 * 60, 10 * 60),
        row(2, 10 * 60, 12 * 60),
        row(2, 12 * 60, 14 * 60),
        row(2, 14 * 60, 16 * 60),
      ]),
    ).toMatch(/3 opening/);
  });

  it("refuses an override interval that is not on a 15-minute mark", () => {
    expect(intervalProblems([{ start: 9 * 60 + 10, end: 10 * 60 }])).toMatch(/15-minute/);
  });

  it("refuses a reserved slug and an unknown time zone", () => {
    const body = {
      slug: "admin",
      displayName: "Studio",
      timeZone: "America/Denver",
      accepting: true,
      minNoticeMinutes: 0,
      horizonDays: 14,
    };
    expect(() => parseProfile(body)).toThrow(/reserved/);
    expect(() => parseProfile({ ...body, slug: "demo-studio", timeZone: "Not/AZone" })).toThrow(/time zone/i);
    expect(parseProfile({ ...body, slug: "demo-studio" }).timeZone).toBe("America/Denver");
  });

  it("refuses more than 60 future overrides", () => {
    const overrides = Array.from({ length: 61 }, (_, i) => {
      const day = new Date(Date.UTC(2026, 0, 1 + i));
      return { date: day.toISOString().slice(0, 10), closed: true, intervals: [] as { start: number; end: number }[] };
    });
    expect(() => parseOverrides({ overrides }, "2026-01-01")).toThrow(/60 future/);
  });
});
