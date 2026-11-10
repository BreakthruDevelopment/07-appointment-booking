import { describe, expect, it } from "vitest";
import { assertSlotRate, clientIp, resetSlotRate } from "@/lib/slot-rate";

describe("slot rate limit", () => {
  it("allows 60 requests per IP per minute and isolates addresses", () => {
    resetSlotRate();
    const now = 1_700_000_000_000;
    for (let i = 0; i < 60; i++) assertSlotRate("203.0.113.5", now + i);
    expect(() => assertSlotRate("203.0.113.5", now + 60)).toThrow(/Too many/);
    expect(() => assertSlotRate("203.0.113.6", now + 60)).not.toThrow();
    expect(() => assertSlotRate("203.0.113.5", now + 60_000)).not.toThrow();
  });

  it("reads the first forwarded address", () => {
    const request = new Request("http://localhost/api/providers/demo/slots", {
      headers: { "x-forwarded-for": "198.51.100.4, 10.0.0.1" },
    });
    expect(clientIp(request)).toBe("198.51.100.4");
    expect(clientIp(new Request("http://localhost/"))).toBe("unknown");
  });
});
