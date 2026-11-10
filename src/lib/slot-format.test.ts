import { describe, expect, it } from "vitest";
import { addDays, chipLabels, dateKeyInZone, dayParts, dayWindow, formatDateTime, formatMinutes, groupByDay, zoneNote } from "./slot-format";

const NY = "America/New_York";

describe("local days and windows", () => {
  it("keys an instant by its local date, not its UTC date", () => {
    expect(dateKeyInZone("2026-03-09T02:30:00Z", NY)).toBe("2026-03-08");
    expect(dateKeyInZone("2026-03-09T02:30:00Z", "Asia/Kolkata")).toBe("2026-03-09");
    expect(dateKeyInZone("2026-06-30T23:30:00Z", "Pacific/Auckland")).toBe("2026-07-01");
  });

  it("adds calendar days across month and year ends", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("makes the spring-forward day 23 hours and the fall-back day 25 hours", () => {
    const spring = dayWindow("2026-03-08", 0, 1, NY);
    expect((spring.to.getTime() - spring.from.getTime()) / 3_600_000).toBe(23);
    const fall = dayWindow("2026-11-01", 0, 1, NY);
    expect((fall.to.getTime() - fall.from.getTime()) / 3_600_000).toBe(25);
  });

  it("gives seven keys and a window that ends where the next week starts", () => {
    const week = dayWindow("2026-03-05", 0, 7, NY);
    expect(week.keys).toEqual(["2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10", "2026-03-11"]);
    const next = dayWindow("2026-03-05", 7, 7, NY);
    expect(next.from.getTime()).toBe(week.to.getTime());
    // Seven local days across a spring-forward is 167 hours, not 168.
    expect((week.to.getTime() - week.from.getTime()) / 3_600_000).toBe(167);
  });

  it("stays inside the 14-day API limit for a 7-day window in every zone", () => {
    for (const zone of [NY, "Europe/London", "Australia/Lord_Howe", "Asia/Kolkata", "Pacific/Kiritimati"]) {
      const w = dayWindow("2026-10-25", 0, 7, zone);
      expect(w.to.getTime() - w.from.getTime()).toBeLessThanOrEqual(14 * 86_400_000);
    }
  });
});

describe("DST display", () => {
  it("groups slots by the viewer's day across the spring-forward gap", () => {
    // 2026-03-08 in New York: 02:00 does not exist. 01:30 EST is 06:30Z, 03:00 EDT is 07:00Z.
    const groups = groupByDay(["2026-03-08T07:00:00Z", "2026-03-08T06:30:00Z", "2026-03-09T04:00:00Z"], NY);
    expect([...groups.keys()]).toEqual(["2026-03-08", "2026-03-09"]);
    expect(chipLabels(groups.get("2026-03-08")!, NY).map((c) => c.label)).toEqual(["1:30 AM", "3:00 AM"]);
  });

  it("labels the two 1:30 AMs on the fall-back day with their zones", () => {
    const first = "2026-11-01T05:30:00Z"; // 1:30 AM EDT
    const second = "2026-11-01T06:30:00Z"; // 1:30 AM EST
    const labels = chipLabels([first, second, "2026-11-01T14:00:00Z"], NY);
    expect(labels.map((c) => c.label)).toEqual(["1:30 AM EDT", "1:30 AM EST", "9:00 AM"]);
  });

  it("shows a 30-minute DST zone (Lord Howe) and a half-hour offset zone (Kolkata) correctly", () => {
    expect(chipLabels(["2026-10-03T15:00:00Z"], "Australia/Lord_Howe")[0].label).toBe("1:30 AM");
    expect(chipLabels(["2026-06-01T03:30:00Z"], "Asia/Kolkata")[0].label).toBe("9:00 AM");
  });

  it("formats a full date and time with the zone abbreviation", () => {
    expect(formatDateTime("2026-11-17T22:00:00Z", "America/Denver")).toBe("Tue, Nov 17, 3:00 PM MST");
    expect(formatDateTime("2026-06-17T21:00:00Z", "America/Denver")).toBe("Wed, Jun 17, 3:00 PM MDT");
  });
});

describe("labels", () => {
  it("formats minutes and day parts", () => {
    expect(formatMinutes(0)).toBe("12:00 AM");
    expect(formatMinutes(9 * 60 + 15)).toBe("9:15 AM");
    expect(formatMinutes(12 * 60)).toBe("12:00 PM");
    expect(formatMinutes(17 * 60 + 30)).toBe("5:30 PM");
    expect(formatMinutes(1440)).toBe("Midnight (24:00)");
    expect(dayParts("2026-11-01")).toEqual({ weekday: "Sun", day: "1", month: "Nov" });
  });

  it("names the viewer's zone and the provider's when they differ", () => {
    expect(zoneNote("America/Denver", "America/Denver", "Demo Studio")).toBe(
      "Times shown in your time zone, America/Denver. That is also Demo Studio's time zone.",
    );
    expect(zoneNote("Europe/London", "America/Denver", "Demo Studio")).toBe(
      "Times shown in your time zone, Europe/London. Demo Studio is in America/Denver.",
    );
  });
});
