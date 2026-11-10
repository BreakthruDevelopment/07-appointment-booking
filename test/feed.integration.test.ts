/**
 * The provider calendar feed and the demo workspace, against Postgres (TEST_DATABASE_URL).
 * The feed token is a bearer secret: only its sha256 is stored, rotating kills the old URL, and the feed shows
 * first names only. Strangers, customers and admins can't mint or read someone else's feed.
 */
import { createHash } from "node:crypto";
import ICAL from "ical.js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth/rbac";

const url = process.env.TEST_DATABASE_URL;

const fp: Actor = { id: "fd-prov", role: "user" };
const fp2: Actor = { id: "fd-prov2", role: "user" };
const fa: Actor = { id: "fd-ann", role: "user" };
const fb: Actor = { id: "fd-ben", role: "user" };
const fadmin: Actor = { id: "fd-admin", role: "admin" };

const NOW = new Date("2026-06-15T12:00:00Z");
const DAY = 86_400_000;

function eventsOf(text: string) {
  const root = new ICAL.Component(ICAL.parse(text));
  return root.getAllSubcomponents("vevent").map((e) => ({
    uid: String(e.getFirstPropertyValue("uid")),
    summary: String(e.getFirstPropertyValue("summary")),
    status: String(e.getFirstPropertyValue("status")),
    sequence: Number(e.getFirstPropertyValue("sequence")),
  }));
}

describe.skipIf(!url)("calendar feed and demo (Postgres)", () => {
  let sql: postgres.Sql;
  let serviceId: string;
  let service2Id: string;

  const wipe = async () => {
    await sql`delete from booking where provider_id like 'fd-%' or customer_id like 'fd-%'`;
    await sql`delete from rate_event where user_id like 'fd-%'`;
    await sql`delete from calendar_feed where provider_id like 'fd-%'`;
  };

  const insert = async (provider: Actor, customer: Actor, svc: string, startsAt: Date, cancelledAt?: Date) => {
    const { insertBookingRow } = await import("@/lib/bookings");
    const { db } = await import("@/lib/db");
    return insertBookingRow(db(), {
      providerId: provider.id,
      customerId: customer.id,
      serviceId: svc,
      serviceName: "Cut",
      startsAt,
      durationMin: 30,
      bufferBeforeMin: 0,
      bufferAfterMin: 0,
      providerTz: "UTC",
      cancelled: cancelledAt ? { by: "customer", at: cancelledAt } : undefined,
    });
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = "http://localhost:3000";
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await wipe();
    await sql`delete from "user" where id like 'fd-%'`;
    const people: [Actor, string][] = [[fp, "Studio Owner"], [fp2, "Other Owner"], [fa, "Ann Lee-Smith"], [fb, "Ben Tester"], [fadmin, "Admin"]];
    for (const [u, name] of people) {
      await sql`insert into "user" (id, name, email, role) values (${u.id}, ${name}, ${u.id + "@test.local"}, ${u.role})`;
    }
    const { saveService, upsertProfile } = await import("@/lib/provider");
    const body = (slug: string) => ({ slug, displayName: slug, bio: "", timeZone: "UTC", accepting: true, minNoticeMinutes: 0, horizonDays: 60 });
    await upsertProfile(fp, body("fd-prov"));
    await upsertProfile(fp2, body("fd-prov2"));
    serviceId = (await saveService(fp, { name: "Cut", durationMin: 30 })).id;
    service2Id = (await saveService(fp2, { name: "Cut", durationMin: 30 })).id;
  });

  beforeEach(wipe);

  afterAll(async () => {
    await wipe();
    await sql`delete from "user" where id like 'fd-%'`;
    await sql`delete from "user" where image = 'urn:breakthru:appointment-booking-demo:v1'`;
    await sql`delete from daily_usage where kind = 'demo_load'`;
    await sql.end();
  });

  it("mints a token once, stores only its sha256, and serves the feed at the returned URL", async () => {
    const { getFeedStatus, renderFeed, rotateFeedToken } = await import("@/lib/feed");
    await expect(getFeedStatus(fp)).resolves.toEqual({ exists: false, createdAt: null });
    const { url: feedUrl } = await rotateFeedToken(fp);
    const match = feedUrl.match(/^http:\/\/localhost:3000\/api\/calendar\/([A-Za-z0-9_-]{43})\.ics$/);
    expect(match).not.toBeNull();
    const token = match![1];
    const [row] = await sql`select token_hash from calendar_feed where provider_id = ${fp.id}`;
    expect(row.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(row.token_hash).not.toContain(token);
    await expect(getFeedStatus(fp)).resolves.toMatchObject({ exists: true });
    // Served with or without the .ics suffix; an empty calendar is still a valid calendar.
    const text = await renderFeed(`${token}.ics`, NOW);
    expect(text).toContain("BEGIN:VCALENDAR");
    expect(eventsOf(text!)).toEqual([]);
    expect(await renderFeed(token, NOW)).toBe(text);
  });

  it("rotating replaces the old URL immediately", async () => {
    const { renderFeed, rotateFeedToken } = await import("@/lib/feed");
    const first = (await rotateFeedToken(fp)).url.split("/").pop()!;
    const second = (await rotateFeedToken(fp)).url.split("/").pop()!;
    expect(second).not.toBe(first);
    expect(await renderFeed(first, NOW)).toBeNull();
    expect(await renderFeed(second, NOW)).not.toBeNull();
    const [{ n }] = await sql`select count(*)::int as n from calendar_feed where provider_id = ${fp.id}`;
    expect(n).toBe(1);
  });

  it("refuses malformed, unknown and look-alike tokens the same way", async () => {
    const { renderFeed, rotateFeedToken } = await import("@/lib/feed");
    const token = (await rotateFeedToken(fp)).url.split("/").pop()!.replace(".ics", "");
    for (const bad of ["", "abc", `${token}x`, token.slice(1), token.toUpperCase(), `${token}%00`, "../../etc/passwd", "A".repeat(43), `${token}.ics.ics`]) {
      expect(await renderFeed(bad, NOW), bad).toBeNull();
    }
    // A booking id or the hash itself is not a credential.
    expect(await renderFeed(createHash("sha256").update(token).digest("hex"), NOW)).toBeNull();
  });

  it("only providers can have a feed, and only for their own calendar", async () => {
    const { renderFeed, rotateFeedToken } = await import("@/lib/feed");
    await expect(rotateFeedToken(fa)).rejects.toMatchObject({ status: 404 });
    await expect(rotateFeedToken(fadmin)).rejects.toMatchObject({ status: 404 });
    await insert(fp, fa, serviceId, new Date(NOW.getTime() + DAY));
    await insert(fp2, fb, service2Id, new Date(NOW.getTime() + 2 * DAY));
    const t1 = (await rotateFeedToken(fp)).url.split("/").pop()!;
    const t2 = (await rotateFeedToken(fp2)).url.split("/").pop()!;
    const one = eventsOf((await renderFeed(t1, NOW))!);
    const two = eventsOf((await renderFeed(t2, NOW))!);
    expect(one.map((e) => e.summary)).toEqual(["Cut - Ann"]);
    expect(two.map((e) => e.summary)).toEqual(["Cut - Ben"]);
  });

  it("shows first names only: no email, no last name, no note", async () => {
    const { renderFeed, rotateFeedToken } = await import("@/lib/feed");
    const { insertBookingRow } = await import("@/lib/bookings");
    const { db } = await import("@/lib/db");
    await insertBookingRow(db(), {
      providerId: fp.id,
      customerId: fa.id,
      serviceId,
      serviceName: "Cut",
      startsAt: new Date(NOW.getTime() + DAY),
      durationMin: 30,
      bufferBeforeMin: 0,
      bufferAfterMin: 0,
      providerTz: "UTC",
      note: "private note for the provider",
    });
    const text = (await renderFeed((await rotateFeedToken(fp)).url.split("/").pop()!, NOW))!;
    expect(text).toContain("Ann");
    for (const secret of ["Lee-Smith", "@test.local", "private note", "fd-ann"]) expect(text).not.toContain(secret);
  });

  it("includes confirmed bookings from 30 days back to 60 ahead and cancelled ones from the last 7 days", async () => {
    const { renderFeed, rotateFeedToken } = await import("@/lib/feed");
    const at = (days: number, hour = 10) => new Date(Date.UTC(2026, 5, 15 + days, hour));
    const ids = {
      recent: await insert(fp, fa, serviceId, at(-29)),
      tooOld: await insert(fp, fa, serviceId, at(-31, 11)),
      soon: await insert(fp, fa, serviceId, at(1)),
      far: await insert(fp, fa, serviceId, at(59)),
      tooFar: await insert(fp, fa, serviceId, at(61, 11)),
      cancelledRecently: await insert(fp, fb, serviceId, at(2), new Date(NOW.getTime() - 2 * DAY)),
      cancelledLongAgo: await insert(fp, fb, serviceId, at(3), new Date(NOW.getTime() - 8 * DAY)),
    };
    const events = eventsOf((await renderFeed((await rotateFeedToken(fp)).url.split("/").pop()!, NOW))!);
    const present = new Set(events.map((e) => e.uid.split("@")[0]));
    expect(present).toEqual(new Set([ids.recent, ids.soon, ids.far, ids.cancelledRecently]));
    const cancelled = events.find((e) => e.uid.startsWith(ids.cancelledRecently))!;
    expect(cancelled).toMatchObject({ status: "CANCELLED", sequence: 1, summary: "Cut - Ben" });
    expect(events.find((e) => e.uid.startsWith(ids.soon))).toMatchObject({ status: "CONFIRMED", sequence: 0 });
  });

  it("shows a booking made and then cancelled through the data functions", async () => {
    const { cancelBooking, createBooking } = await import("@/lib/bookings");
    const { renderFeed, rotateFeedToken } = await import("@/lib/feed");
    const { replaceHours } = await import("@/lib/provider");
    await replaceHours(fp, { hours: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMin: 0, endMin: 1440 })) });
    const made = await createBooking(fa, { serviceId, startsAt: "2026-06-16T10:00:00.000Z" }, NOW);
    const token = (await rotateFeedToken(fp)).url.split("/").pop()!;
    expect(eventsOf((await renderFeed(token, NOW))!)).toMatchObject([{ status: "CONFIRMED" }]);
    await cancelBooking(fa, made.id, NOW);
    expect(eventsOf((await renderFeed(token, NOW))!)).toMatchObject([{ uid: `${made.id}@app7.breakthruventures.ai`, status: "CANCELLED", sequence: 1 }]);
  });

  it("limits rotations to 5 an hour per provider", async () => {
    const { rotateFeedToken } = await import("@/lib/feed");
    for (let i = 0; i < 5; i++) await rotateFeedToken(fp2);
    await expect(rotateFeedToken(fp2)).rejects.toMatchObject({ status: 429 });
    await expect(rotateFeedToken(fp)).resolves.toBeTruthy();
  });

  describe("demo workspace", () => {
    beforeEach(async () => {
      await sql`delete from daily_usage where kind = 'demo_load'`;
    });

    it("is admin-only", async () => {
      const { loadDemoWorkspace } = await import("@/lib/demo");
      await expect(loadDemoWorkspace(fa)).rejects.toMatchObject({ status: 403 });
      await expect(loadDemoWorkspace(fp)).rejects.toMatchObject({ status: 403 });
    });

    it("creates Demo Studio with three services, two customers and bookings around the DST change, and reloads cleanly", async () => {
      const { loadDemoWorkspace } = await import("@/lib/demo");
      const first = await loadDemoWorkspace(fadmin, NOW);
      expect(first).toMatchObject({ slug: "demo-studio", services: 3, customers: 2, dstDate: "2026-03-08" });
      expect(first.bookings).toBeGreaterThanOrEqual(6);
      const [profile] = await sql`select display_name, time_zone, accepting from provider_profile where slug = 'demo-studio'`;
      expect(profile).toMatchObject({ display_name: "Demo Studio", time_zone: "America/Denver", accepting: true });
      // Bookings straddle the spring-forward Sunday: some at -07 (MST), some at -06 (MDT).
      const rows = await sql`
        select status,
          (extract(hour from starts_at at time zone 'UTC') - extract(hour from starts_at at time zone 'America/Denver'))::int as utc_offset
        from booking where provider_id = 'demo-studio-provider'`;
      expect(new Set(rows.map((r) => r.utc_offset))).toEqual(new Set([6, 7]));
      expect(rows.some((r) => r.status === "cancelled")).toBe(true);
      const second = await loadDemoWorkspace(fadmin, NOW);
      expect(second).toEqual(first);
      const [{ n }] = await sql`select count(*)::int as n from provider_profile where slug = 'demo-studio'`;
      expect(n).toBe(1);
      // Demo accounts carry no password, so nobody can sign in as them.
      const [{ accounts }] = await sql`select count(*)::int as accounts from account where user_id like 'demo-%'`;
      expect(accounts).toBe(0);
    });

    it("refuses to overwrite a real account that uses a demo email or the demo link", async () => {
      const { loadDemoWorkspace } = await import("@/lib/demo");
      await sql`delete from "user" where image = 'urn:breakthru:appointment-booking-demo:v1'`;
      await sql`insert into "user" (id, name, email) values ('fd-squatter', 'Real', 'avery@demo.breakthru.test')`;
      try {
        await expect(loadDemoWorkspace(fadmin, NOW)).rejects.toMatchObject({ status: 409 });
      } finally {
        await sql`delete from "user" where id = 'fd-squatter'`;
      }
    });

    it("is capped per day", async () => {
      const { DEMO_LOADS_PER_DAY, loadDemoWorkspace } = await import("@/lib/demo");
      for (let i = 0; i < DEMO_LOADS_PER_DAY; i++) await loadDemoWorkspace(fadmin, NOW);
      await expect(loadDemoWorkspace(fadmin, NOW)).rejects.toMatchObject({ status: 429 });
    });
  });
});
