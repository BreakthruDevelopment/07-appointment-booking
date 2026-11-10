/**
 * Bookings, cancellation and .ics against Postgres (TEST_DATABASE_URL).
 * Rules covered: server-side re-validation, 23P01 -> 409, the 10-way race, caps and rate limits, who may
 * cancel and when, and that only a booking's customer and provider can see it (404 for everyone else, admin included).
 */
import ICAL from "ical.js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth/rbac";

const url = process.env.TEST_DATABASE_URL;

const prov: Actor = { id: "bk-prov", role: "user" };
const prov2: Actor = { id: "bk-prov2", role: "user" };
const ann: Actor = { id: "bk-ann", role: "user" };
const ben: Actor = { id: "bk-ben", role: "user" };
const cat: Actor = { id: "bk-cat", role: "user" };
const admin: Actor = { id: "bk-admin", role: "admin" };
const crowd: Actor[] = Array.from({ length: 10 }, (_, i) => ({ id: `bk-crowd${i}`, role: "user" as const }));
const names: Record<string, string> = { "bk-ann": "Ann Lee-Smith", "bk-ben": "Ben Tester", "bk-cat": "Cat" };

const NOW = new Date("2026-06-01T00:00:00Z");
const SLOT = "2026-06-03T10:00:00.000Z";

function profileBody(slug: string, extra: Record<string, unknown> = {}) {
  return { slug, displayName: `Studio ${slug}`, bio: "", timeZone: "UTC", accepting: true, minNoticeMinutes: 0, horizonDays: 60, ...extra };
}

describe.skipIf(!url)("bookings (Postgres)", () => {
  let sql: postgres.Sql;
  let serviceId: string;
  let service2Id: string;
  let bufferedId: string;

  const wipe = async () => {
    await sql`delete from booking where provider_id like 'bk-%' or customer_id like 'bk-%'`;
    await sql`delete from rate_event where user_id like 'bk-%'`;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    // A pool as big as the crowd, so all 10 concurrent requests really hold a connection at once.
    process.env.DB_POOL_MAX = "10";
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = "http://localhost:3000";
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await wipe();
    await sql`delete from "user" where id like 'bk-%'`;
    for (const u of [prov, prov2, ann, ben, cat, admin, ...crowd]) {
      const name = names[u.id] ?? u.id;
      await sql`insert into "user" (id, name, email, role) values (${u.id}, ${name}, ${u.id + "@test.local"}, ${u.role})`;
    }
    const { replaceHours, saveService, upsertProfile } = await import("@/lib/provider");
    const everyDay = { hours: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMin: 0, endMin: 1440 })) };
    await upsertProfile(prov, profileBody("bk-prov"));
    await upsertProfile(prov2, profileBody("bk-prov2"));
    await replaceHours(prov, everyDay);
    await replaceHours(prov2, everyDay);
    serviceId = (await saveService(prov, { name: "Cut", durationMin: 30 })).id;
    bufferedId = (await saveService(prov, { name: "Long", durationMin: 60, bufferBeforeMin: 15, bufferAfterMin: 15 })).id;
    service2Id = (await saveService(prov2, { name: "Cut", durationMin: 30 })).id;
  });

  beforeEach(wipe);

  afterAll(async () => {
    await wipe();
    await sql`delete from "user" where id like 'bk-%'`;
    await sql.end();
  });

  const book = async (actor: Actor, startsAt = SLOT, extra: Record<string, unknown> = {}, svc = serviceId) => {
    const { createBooking } = await import("@/lib/bookings");
    return createBooking(actor, { serviceId: svc, startsAt, ...extra }, NOW);
  };

  it("creates a booking, with the customer's and the provider's views differing", async () => {
    const { getBooking } = await import("@/lib/bookings");
    const made = await book(ann, SLOT, { note: "  first time  " });
    expect(made).toMatchObject({ role: "customer", status: "confirmed", serviceName: "Cut", durationMin: 30, customerName: null, customerNote: "first time", sequence: 0 });
    expect(made.endsAt).toBe("2026-06-03T10:30:00.000Z");
    const asProvider = await getBooking(prov, made.id);
    expect(asProvider).toMatchObject({ role: "provider", customerName: "Ann Lee-Smith" });
    expect(JSON.stringify([made, asProvider])).not.toContain("@");
    const [row] = await sql`select lower(slot) as s, upper(slot) as e, lower(blocked) as bs from booking where id = ${made.id}`;
    expect(new Date(row.s).toISOString()).toBe(SLOT);
    expect(new Date(row.e).toISOString()).toBe(made.endsAt);
  });

  it("re-validates the time on the server: off-grid, closed, outside notice or horizon, wrong owner, unknown fields", async () => {
    const { upsertProfile, saveService } = await import("@/lib/provider");
    const unavailable = { status: 409, extra: { code: "slot_unavailable" } };
    // Not on the 15-minute grid.
    await expect(book(ann, "2026-06-03T10:07:00.000Z")).rejects.toMatchObject(unavailable);
    // In the past, and past the 60-day horizon.
    await expect(book(ann, "2026-05-30T10:00:00.000Z")).rejects.toMatchObject(unavailable);
    await expect(book(ann, "2026-09-03T10:00:00.000Z")).rejects.toMatchObject(unavailable);
    // Minimum notice.
    await upsertProfile(prov, profileBody("bk-prov", { minNoticeMinutes: 60 * 24 * 7 }));
    await expect(book(ann, "2026-06-03T10:00:00.000Z")).rejects.toMatchObject(unavailable);
    await upsertProfile(prov, profileBody("bk-prov"));
    // Provider stops accepting.
    await upsertProfile(prov, profileBody("bk-prov", { accepting: false }));
    await expect(book(ann)).rejects.toMatchObject({ status: 404 });
    await upsertProfile(prov, profileBody("bk-prov"));
    // Inactive service reads as unavailable.
    const inactive = await saveService(prov, { name: "Hidden", durationMin: 30, active: false });
    await expect(book(ann, SLOT, {}, inactive.id)).rejects.toMatchObject(unavailable);
    // Closed day by override.
    const { replaceOverrides } = await import("@/lib/provider");
    await replaceOverrides(prov, { overrides: [{ date: "2026-06-04", closed: true, intervals: [] }] }, NOW);
    await expect(book(ann, "2026-06-04T10:00:00.000Z")).rejects.toMatchObject(unavailable);
    await replaceOverrides(prov, { overrides: [] }, NOW);
    // Bad shape: not a UUID, not a date, unknown fields a client might try to smuggle in, long note.
    const { createBooking } = await import("@/lib/bookings");
    await expect(createBooking(ann, { serviceId: "nope", startsAt: SLOT }, NOW)).rejects.toMatchObject({ name: "ZodError" });
    await expect(createBooking(ann, { serviceId, startsAt: "tomorrow" }, NOW)).rejects.toMatchObject({ name: "ZodError" });
    await expect(createBooking(ann, { serviceId, startsAt: SLOT, providerId: ben.id }, NOW)).rejects.toMatchObject({ name: "ZodError" });
    await expect(createBooking(ann, { serviceId, startsAt: SLOT, endsAt: SLOT }, NOW)).rejects.toMatchObject({ name: "ZodError" });
    await expect(createBooking(ann, { serviceId, startsAt: SLOT, note: "x".repeat(301) }, NOW)).rejects.toMatchObject({ name: "ZodError" });
    // Unknown service, and a provider booking their own service.
    await expect(book(ann, SLOT, {}, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ status: 404 });
    await expect(book(prov)).rejects.toMatchObject({ status: 400 });
    const [{ n }] = await sql`select count(*)::int as n from booking`;
    expect(n).toBe(0);
  });

  it("answers 409 slot_taken with fresh slots when the time is held, including by buffers", async () => {
    await book(ann, SLOT, {}, bufferedId); // blocks 09:45 - 11:15
    const taken = await book(ben, "2026-06-03T10:30:00.000Z").catch((e) => e);
    expect(taken).toMatchObject({ status: 409, extra: { code: "slot_taken" } });
    const slots = taken.extra.slots as string[];
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.length).toBeLessThanOrEqual(12);
    expect(slots).not.toContain("2026-06-03T10:30:00.000Z");
    expect(slots).not.toContain(SLOT);
    // 11:15 is the first start clear of the buffer.
    await expect(book(ben, "2026-06-03T11:15:00.000Z")).resolves.toMatchObject({ status: "confirmed" });
  });

  it("maps a database 23P01 to 409 even if availability said yes (customer can't be in two places)", async () => {
    await book(ann, SLOT);
    // Same customer, other provider, overlapping time: the engine for prov2 says free, the customer constraint refuses.
    const err = await book(ann, "2026-06-03T10:15:00.000Z", {}, service2Id).catch((e) => e);
    expect(err).toMatchObject({ status: 409, extra: { code: "slot_taken" } });
    expect(err.message).toMatch(/already have a booking/);
  });

  it("lets exactly one of 10 concurrent customers win a slot, 20 rounds in a row", async () => {
    const { createBooking } = await import("@/lib/bookings");
    for (let round = 0; round < 20; round++) {
      await wipe();
      const results = await Promise.allSettled(crowd.map((actor) => createBooking(actor, { serviceId, startsAt: SLOT }, NOW)));
      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(won, `round ${round}`).toHaveLength(1);
      expect(lost).toHaveLength(9);
      for (const r of lost) expect(r.reason).toMatchObject({ status: 409, extra: { code: "slot_taken" } });
      const [{ n }] = await sql`select count(*)::int as n from booking where provider_id = ${prov.id} and status = 'confirmed'`;
      expect(n).toBe(1);
    }
  }, 120_000);

  it("waits for a provider edit in flight, then re-checks against it (no booking on a slot the edit closed)", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const editing = sql.begin(async (tx) => {
      // What an edit of the provider's profile holds from its first write until it commits.
      await tx`select user_id from provider_profile where user_id = ${prov.id} for update`;
      await tx`update provider_profile set accepting = false where user_id = ${prov.id}`;
      await held;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    let settled = false;
    const booking = book(ann).then(
      (v) => ((settled = true), v),
      (e) => ((settled = true), Promise.reject(e)),
    );
    booking.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(settled, "the booking must wait for the in-flight edit").toBe(false);
    release();
    await editing;
    await expect(booking).rejects.toMatchObject({ status: 404 });
    await sql`update provider_profile set accepting = true where user_id = ${prov.id}`;
    const [{ n }] = await sql`select count(*)::int as n from booking where provider_id = ${prov.id}`;
    expect(n).toBe(0);
  });

  it("lets one customer's concurrent bookings through only up to the per-provider cap", async () => {
    const { createBooking } = await import("@/lib/bookings");
    const times = Array.from({ length: 8 }, (_, i) => new Date(Date.parse("2026-06-05T09:00:00Z") + i * 3_600_000).toISOString());
    const results = await Promise.allSettled(times.map((startsAt) => createBooking(ann, { serviceId, startsAt }, NOW)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    for (const r of results.filter((r): r is PromiseRejectedResult => r.status === "rejected")) {
      expect(r.reason).toMatchObject({ status: 409, extra: { code: "limit_reached" } });
    }
  });

  it("caps upcoming bookings overall at 10", async () => {
    const { insertBookingRow } = await import("@/lib/bookings");
    const { db } = await import("@/lib/db");
    for (let i = 0; i < 10; i++) {
      await insertBookingRow(db(), { providerId: prov.id, customerId: ann.id, serviceId, serviceName: "Cut", startsAt: new Date(Date.parse("2026-07-01T00:00:00Z") + i * 86_400_000), durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, providerTz: "UTC" });
    }
    await expect(book(ann, SLOT, {}, service2Id)).rejects.toMatchObject({ status: 409, extra: { code: "limit_reached" } });
    await expect(book(ben, SLOT, {}, service2Id)).resolves.toMatchObject({ status: "confirmed" });
  });

  it("limits booking attempts to 10 an hour, counting failed attempts", async () => {
    for (let i = 0; i < 10; i++) await expect(book(cat, "2026-06-03T10:07:00.000Z")).rejects.toMatchObject({ status: 409 });
    await expect(book(cat)).rejects.toMatchObject({ status: 429 });
    // Another user is unaffected.
    await expect(book(ben)).resolves.toMatchObject({ status: "confirmed" });
  });

  describe("cancellation", () => {
    it("lets the customer cancel, is idempotent, frees the slot, and bumps sequence once", async () => {
      const { cancelBooking } = await import("@/lib/bookings");
      const made = await book(ann);
      const first = await cancelBooking(ann, made.id, NOW);
      expect(first).toMatchObject({ status: "cancelled", cancelledBy: "customer", sequence: 1 });
      const again = await cancelBooking(ann, made.id, new Date(NOW.getTime() + 5_000));
      expect(again).toMatchObject({ status: "cancelled", cancelledBy: "customer", sequence: 1, cancelledAt: first.cancelledAt });
      // Providers see it as cancelled too, and the slot is free again.
      await expect(cancelBooking(prov, made.id, NOW)).resolves.toMatchObject({ status: "cancelled", cancelledBy: "customer", sequence: 1 });
      await expect(book(ben)).resolves.toMatchObject({ status: "confirmed" });
    });

    it("bumps sequence once even when cancelled twice at the same moment", async () => {
      const { cancelBooking } = await import("@/lib/bookings");
      const made = await book(ann);
      const results = await Promise.all([cancelBooking(ann, made.id, NOW), cancelBooking(ann, made.id, NOW), cancelBooking(prov, made.id, NOW)]);
      for (const r of results) expect(r.status).toBe("cancelled");
      const [row] = await sql`select sequence, cancelled_by from booking where id = ${made.id}`;
      expect(row.sequence).toBe(1);
    });

    it("lets the provider cancel a booking (any time before it starts)", async () => {
      const { cancelBooking } = await import("@/lib/bookings");
      const { upsertProfile } = await import("@/lib/provider");
      const made = await book(ann);
      await upsertProfile(prov, profileBody("bk-prov", { minNoticeMinutes: 10080 }));
      try {
        // Customer is inside the notice window now; the provider is not bound by it.
        await expect(cancelBooking(ann, made.id, NOW)).rejects.toMatchObject({ status: 409, extra: { code: "cancellation_closed" } });
        await expect(cancelBooking(prov, made.id, NOW)).resolves.toMatchObject({ status: "cancelled", cancelledBy: "provider", sequence: 1 });
      } finally {
        await upsertProfile(prov, profileBody("bk-prov"));
      }
    });

    it("applies the customer cutoff of starts_at minus the provider's notice", async () => {
      const { cancelBooking } = await import("@/lib/bookings");
      const { upsertProfile } = await import("@/lib/provider");
      const made = await book(ann);
      await upsertProfile(prov, profileBody("bk-prov", { minNoticeMinutes: 120 }));
      try {
        const cutoff = Date.parse(SLOT) - 120 * 60_000;
        await expect(cancelBooking(ann, made.id, new Date(cutoff + 60_000))).rejects.toMatchObject({ status: 409, extra: { code: "cancellation_closed" } });
        await expect(cancelBooking(ann, made.id, new Date(cutoff))).resolves.toMatchObject({ status: "cancelled" });
      } finally {
        await upsertProfile(prov, profileBody("bk-prov"));
      }
    });

    it("refuses to cancel an appointment that has started, for both sides", async () => {
      const { cancelBooking } = await import("@/lib/bookings");
      const made = await book(ann);
      const after = new Date(Date.parse(SLOT) + 60_000);
      await expect(cancelBooking(ann, made.id, after)).rejects.toMatchObject({ status: 409, extra: { code: "already_started" } });
      await expect(cancelBooking(prov, made.id, after)).rejects.toMatchObject({ status: 409, extra: { code: "already_started" } });
    });

    it("answers 404 to another user, an admin, another provider and a malformed id, and changes nothing", async () => {
      const { cancelBooking } = await import("@/lib/bookings");
      const made = await book(ann);
      for (const stranger of [ben, admin, prov2]) {
        await expect(cancelBooking(stranger, made.id, NOW)).rejects.toMatchObject({ status: 404 });
      }
      await expect(cancelBooking(ann, "not-a-uuid", NOW)).rejects.toMatchObject({ status: 404 });
      await expect(cancelBooking(ann, "00000000-0000-4000-8000-000000000000", NOW)).rejects.toMatchObject({ status: 404 });
      const [row] = await sql`select status, sequence from booking where id = ${made.id}`;
      expect(row).toMatchObject({ status: "confirmed", sequence: 0 });
    });
  });

  describe("who can see a booking", () => {
    it("shows it to its customer and provider, and answers 404 to everyone else including admin", async () => {
      const { getBooking, getBookingIcs, listBookings } = await import("@/lib/bookings");
      const made = await book(ann);
      await expect(getBooking(ann, made.id)).resolves.toMatchObject({ id: made.id });
      await expect(getBooking(prov, made.id)).resolves.toMatchObject({ id: made.id });
      await expect(getBookingIcs(ann, made.id)).resolves.toBeTruthy();
      await expect(getBookingIcs(prov, made.id)).resolves.toBeTruthy();
      for (const stranger of [ben, admin, prov2]) {
        await expect(getBooking(stranger, made.id)).rejects.toMatchObject({ status: 404 });
        await expect(getBookingIcs(stranger, made.id)).rejects.toMatchObject({ status: 404 });
        await expect(listBookings(stranger, { when: "all" }, NOW)).resolves.toEqual([]);
        await expect(listBookings(stranger, { as: "provider", when: "all" }, NOW)).resolves.toEqual([]);
      }
      await expect(getBooking(ann, "garbage")).rejects.toMatchObject({ status: 404 });
    });

    it("lists a customer's bookings and a provider's calendar separately, with upcoming and past filters", async () => {
      const { insertBookingRow, listBookings } = await import("@/lib/bookings");
      const { db } = await import("@/lib/db");
      await insertBookingRow(db(), { providerId: prov.id, customerId: ann.id, serviceId, serviceName: "Cut", startsAt: new Date("2026-05-20T10:00:00Z"), durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, providerTz: "UTC" });
      const upcoming = await book(ann);
      await book(ben, "2026-06-03T12:00:00.000Z");
      const mine = await listBookings(ann, { when: "all" }, NOW);
      expect(mine.map((b) => b.id)).toContain(upcoming.id);
      expect(mine).toHaveLength(2);
      expect(mine.every((b) => b.role === "customer" && b.customerName === null)).toBe(true);
      expect(await listBookings(ann, { when: "upcoming" }, NOW)).toHaveLength(1);
      expect(await listBookings(ann, { when: "past" }, NOW)).toHaveLength(1);
      const calendar = await listBookings(prov, { as: "provider", when: "all" }, NOW);
      expect(calendar).toHaveLength(3);
      expect(calendar.map((b) => b.customerName).sort()).toEqual(["Ann Lee-Smith", "Ann Lee-Smith", "Ben Tester"]);
      // A provider asking for the customer side sees only what they booked themselves.
      expect(await listBookings(prov, { as: "customer", when: "all" }, NOW)).toEqual([]);
      await expect(listBookings(ann, { as: "admin" }, NOW)).rejects.toMatchObject({ name: "ZodError" });
      await expect(listBookings(ann, { limit: "1000" }, NOW)).rejects.toMatchObject({ name: "ZodError" });
    });
  });

  describe(".ics", () => {
    it("parses with ical.js, uses the viewer's side for the summary, and leaks no email or note", async () => {
      const { getBookingIcs } = await import("@/lib/bookings");
      const made = await book(ann, SLOT, { note: "my secret note, with; punctuation" });
      const forCustomer = await getBookingIcs(ann, made.id);
      const forProvider = await getBookingIcs(prov, made.id);
      const read = (text: string) => new ICAL.Event(new ICAL.Component(ICAL.parse(text)).getFirstSubcomponent("vevent")!);
      expect(read(forCustomer.body).summary).toBe("Cut with Studio bk-prov");
      expect(read(forProvider.body).summary).toBe("Cut - Ann");
      expect(read(forCustomer.body).uid).toBe(`${made.id}@app7.breakthruventures.ai`);
      expect(read(forProvider.body).startDate.toJSDate().toISOString()).toBe(SLOT);
      for (const text of [forCustomer.body, forProvider.body]) {
        expect(text).not.toContain("@test.local");
        expect(text).not.toContain("secret note");
        expect(text).not.toContain("Lee-Smith");
      }
      expect(forCustomer.filename).toMatch(/^booking-[0-9a-f]{8}\.ics$/);
    });

    it("keeps the UID, raises SEQUENCE and sets STATUS:CANCELLED after a cancel", async () => {
      const { cancelBooking, getBookingIcs } = await import("@/lib/bookings");
      const made = await book(ann);
      const before = new ICAL.Component(ICAL.parse((await getBookingIcs(ann, made.id)).body)).getFirstSubcomponent("vevent")!;
      await cancelBooking(ann, made.id, NOW);
      const after = new ICAL.Component(ICAL.parse((await getBookingIcs(ann, made.id)).body)).getFirstSubcomponent("vevent")!;
      expect(after.getFirstPropertyValue("uid")).toBe(before.getFirstPropertyValue("uid"));
      expect(before.getFirstPropertyValue("status")).toBe("CONFIRMED");
      expect(before.getFirstPropertyValue("sequence")).toBe(0);
      expect(after.getFirstPropertyValue("status")).toBe("CANCELLED");
      expect(after.getFirstPropertyValue("sequence")).toBe(1);
    });
  });
});
