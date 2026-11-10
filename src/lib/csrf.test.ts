import { describe, expect, it } from "vitest";

describe("requireSameOrigin", () => {
  it("refuses a cross-origin or origin-less mutating request and allows our own", async () => {
    process.env.DATABASE_URL ??= "postgres://localhost/unused";
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = "http://localhost:3000";
    const { requireSameOrigin } = await import("@/lib/csrf");
    const put = (origin?: string) =>
      new Request("http://localhost:3000/api/provider/profile", { method: "PUT", headers: origin ? { origin } : {} });
    expect(() => requireSameOrigin(put("https://evil.example"))).toThrow(/Cross-origin/);
    expect(() => requireSameOrigin(put("https://app5.breakthruventures.ai"))).toThrow(/Cross-origin/);
    expect(() => requireSameOrigin(put())).toThrow(/Cross-origin/);
    expect(() => requireSameOrigin(put("http://localhost:3000"))).not.toThrow();
  });
});
