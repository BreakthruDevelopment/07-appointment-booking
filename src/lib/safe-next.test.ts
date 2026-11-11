import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

describe("safeNext", () => {
  it("keeps same-site paths", () => {
    expect(safeNext("/p/demo-studio")).toBe("/p/demo-studio");
    expect(safeNext("/p/demo-studio/chat")).toBe("/p/demo-studio/chat");
    expect(safeNext("/bookings/")).toBe("/bookings/");
    expect(safeNext("/a/b.c/d-e_f")).toBe("/a/b.c/d-e_f");
    expect(safeNext("/a%20b")).toBe("/a%20b");
    expect(safeNext(["/bookings", "/x"])).toBe("/bookings");
  });

  it.each([
    "//evil.example",
    "/\\evil.example",
    "https://evil.example",
    "javascript:alert(1)",
    "p/x",
    "",
    "/a?b=c",
    "/a#b",
    "/a b",
  ])("refuses the basics: %j", (value) => {
    expect(safeNext(value)).toBe("/dashboard");
  });

  it.each([
    "/.//evil.example",
    "/..//evil.example",
    "/%2e%2e//evil.example",
    "/%2E%2E//evil.example",
    "/a//b",
    "/a/b//",
    "/p/x//evil.example",
    "/%2f/evil.example",
    "/%2F%2Fevil.example",
    "/%5cevil.example",
    "/a%5Cb",
  ])("refuses a double slash anywhere, encoded or not: %j", (value) => {
    expect(safeNext(value)).toBe("/dashboard");
  });

  it.each(["/.", "/..", "/./a", "/a/./b", "/a/../b", "/a/..", "/%2e", "/%2e%2e", "/a/%2e%2e/b", "/a/%2E/b", "/.%2e/a", "/%252e%252e/a", "/%252e/a"])(
    "refuses dot segments, encoded or not: %j",
    (value) => {
      expect(safeNext(value)).toBe("/dashboard");
    },
  );

  it.each(["/a%00b", "/a%0ab", "/a%0d%0ab", "/%", "/%zz", "/a%2"])("refuses control characters and broken escapes: %j", (value) => {
    expect(safeNext(value)).toBe("/dashboard");
  });

  it("keeps names that merely contain dots", () => {
    expect(safeNext("/a/.hidden")).toBe("/a/.hidden");
    expect(safeNext("/a/b..c")).toBe("/a/b..c");
    expect(safeNext("/a/..b")).toBe("/a/..b");
  });

  it("refuses very long values", () => {
    expect(safeNext(`/${"a".repeat(200)}`)).toBe("/dashboard");
  });

  it("falls back when missing", () => {
    expect(safeNext(undefined)).toBe("/dashboard");
    expect(safeNext([])).toBe("/dashboard");
  });
});
