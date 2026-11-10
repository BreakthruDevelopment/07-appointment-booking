import { describe, expect, it } from "vitest";
import { nearestTransition } from "@/lib/demo";

describe("nearestTransition", () => {
  it("finds the daylight-saving change nearest to now, before or after", () => {
    expect(nearestTransition("America/Denver", new Date("2026-11-10T12:00:00Z")).date).toBe("2026-11-01");
    expect(nearestTransition("America/Denver", new Date("2026-02-20T12:00:00Z")).date).toBe("2026-03-08");
    expect(nearestTransition("America/Denver", new Date("2026-03-20T12:00:00Z")).date).toBe("2026-03-08");
  });

  it("falls back to today for a zone without daylight saving", () => {
    expect(nearestTransition("Asia/Kolkata", new Date("2026-06-15T12:00:00Z")).date).toBe("2026-06-15");
  });
});
