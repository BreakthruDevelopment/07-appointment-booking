/**
 * Nobody can sign up as a demo identity or turn an account into one (the auth hooks in src/lib/auth),
 * while the demo loader, which writes with Drizzle directly, is unaffected.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct-horse-battery";
const MARKER = "urn:breakthru:appointment-booking-demo:v1";

describe.skipIf(!url)("demo identity hooks (Better Auth + Postgres)", () => {
  let sql: postgres.Sql;
  let handler: (req: Request) => Promise<Response>;
  let cookie: string;

  const call = (path: string, body: unknown, withCookie?: string) =>
    handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(withCookie ? { cookie: withCookie } : {}) },
        body: JSON.stringify(body),
      }),
    );

  const cleanup = () => sql`delete from "user" where email like 'di-%@test.local' or email like 'di-%@demo.breakthru.test'`;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = "http://localhost:3000";
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await cleanup();
    const { auth } = await import("@/lib/auth");
    handler = auth().handler;
    const res = await call("/sign-up/email", { name: "Plain", email: "di-plain@test.local", password: PASSWORD });
    expect(res.status).toBe(200);
    cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  it("refuses public sign-up with a demo email, in any case, and creates no user", async () => {
    for (const email of ["di-a@demo.breakthru.test", "DI-B@Demo.Breakthru.Test"]) {
      const res = await call("/sign-up/email", { name: "Fake", email, password: PASSWORD });
      expect(res.status).toBe(400);
    }
    const [{ n }] = await sql`select count(*)::int as n from "user" where email ilike 'di-%@demo.breakthru.test'`;
    expect(n).toBe(0);
  });

  it("refuses sign-up that carries the demo marker image", async () => {
    const res = await call("/sign-up/email", { name: "Fake", email: "di-marker@test.local", password: PASSWORD, image: MARKER });
    expect(res.status).toBe(400);
    const [{ n }] = await sql`select count(*)::int as n from "user" where email = 'di-marker@test.local'`;
    expect(n).toBe(0);
  });

  it("refuses update-user setting the marker, and leaves the image alone", async () => {
    const res = await call("/update-user", { image: MARKER }, cookie);
    expect(res.status).toBe(400);
    const [row] = await sql`select image from "user" where email = 'di-plain@test.local'`;
    expect(row.image).not.toBe(MARKER);
    // Ordinary updates still work.
    expect((await call("/update-user", { name: "Plain Two" }, cookie)).status).toBe(200);
  });

  it("does not block the demo loader, which writes rows directly", async () => {
    const { loadDemoWorkspace } = await import("@/lib/demo");
    await sql`delete from daily_usage where kind = 'demo_load'`;
    await expect(loadDemoWorkspace({ id: "di-admin", role: "admin" })).resolves.toMatchObject({ slug: "demo-studio", customers: 2 });
    await sql`delete from "user" where image = ${MARKER}`;
    await sql`delete from daily_usage where kind = 'demo_load'`;
  });
});
