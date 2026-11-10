import { describe, expect, it } from "vitest";
import { profileInput } from "@/lib/provider-rules";
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

describe("profile slug", () => {
  const parse = (slug: string) =>
    profileInput.safeParse({ slug, displayName: "x", timeZone: "UTC", accepting: true, minNoticeMinutes: 0, horizonDays: 7 }).success;

  it("accepts 3 to 40 lowercase letters, digits and single inner hyphens", () => {
    for (const slug of ["abc", "a-b", "anon-studio", "a1b", "a".repeat(40)]) expect(parse(slug), slug).toBe(true);
  });

  it("rejects leading, trailing and doubled hyphens, bad characters and wrong lengths", () => {
    for (const slug of ["-abc", "abc-", "a--b", "ab", "a".repeat(41), "ABC", "a_b", "a b"]) expect(parse(slug), slug).toBe(false);
  });
});
