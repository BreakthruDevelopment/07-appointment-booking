import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it("keeps same-site paths", () => {
    expect(safeNext("/p/demo-studio")).toBe("/p/demo-studio");
    expect(safeNext(["/bookings", "/x"])).toBe("/bookings");
  });
  it.each(["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "p/x", "", "/a?b=c", "/a b"])("refuses %j", (value) => {
    expect(safeNext(value)).toBe("/dashboard");
  });
  it("falls back when missing", () => {
    expect(safeNext(undefined)).toBe("/dashboard");
  });
});
