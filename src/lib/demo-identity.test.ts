import { describe, expect, it } from "vitest";
import { isDemoEmail } from "./demo-identity";

describe("isDemoEmail", () => {
  it("matches the demo domain only, ignoring case and spaces", () => {
    expect(isDemoEmail("ada@demo.breakthru.test")).toBe(true);
    expect(isDemoEmail(" ADA@Demo.Breakthru.Test ")).toBe(true);
    expect(isDemoEmail("ada@example.test")).toBe(false);
    expect(isDemoEmail("ada@evil-demo.breakthru.test.example")).toBe(false);
    expect(isDemoEmail(undefined)).toBe(false);
  });
});
