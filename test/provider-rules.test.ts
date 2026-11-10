import { describe, expect, it } from "vitest";
import { isKnownZone } from "@/lib/provider-rules";

describe("isKnownZone", () => {
  it("accepts canonical zones and valid aliases that Intl.supportedValuesOf omits", () => {
    for (const z of ["UTC", "America/New_York", "Europe/London", "Australia/Lord_Howe", "Asia/Kolkata", "US/Eastern"]) {
      expect(isKnownZone(z), z).toBe(true);
    }
  });

  it("rejects unknown, malformed, empty and oversized zones", () => {
    for (const z of ["", "Mars/Olympus", "America/Nowhere", "not a zone", "../etc/passwd", "A".repeat(81)]) {
      expect(isKnownZone(z), z).toBe(false);
    }
  });
});
