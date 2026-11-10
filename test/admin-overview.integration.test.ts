/**
 * The admin overview is counts only and admin only; `cancelBy` tells the page when a viewer can still cancel.
 * Runs against Postgres (TEST_DATABASE_URL).
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth/rbac";

const url = process.env.TEST_DATABASE_URL;
const prov: Actor = { id: "ao-prov", role: "user" };
const cust: Actor = { id: "ao-cust", role: "user" };
const admin: Actor = { id: "ao-admin", role: "admin" };
const NOW = new Date("2026-06-15T12:00:00Z");

describe.skipIf(!url)("admin overview and cancelBy (Postgres)", () => {
  let sql: postgres.Sql;
  let bookingId: string;
  const startsAt = new Date(NOW.getTime() + 3 * 86_400_000);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = "http://localhost:3000";
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await sql`delete from booking where provider_id like 'ao-%'`;
    await sql`delete from "user" where id like 'ao-%'`;
    for (const [u, name] of [[prov, "Owner"], [cust, "Cora Customer"], [admin, "Admin"]] as [Actor, string][]) {
      await sql`insert into "user" (id, name, email, role) values (${u.id}, ${name}, ${u.id + "@test.local"}, ${u.role})`;
    }
    const { saveService, upsertProfile } = await import("@/lib/provider");
    await upsertProfile(prov, { slug: "ao-prov", displayName: "AO", bio: "", timeZone: "UTC", accepting: true, minNoticeMinutes: 120, horizonDays: 60 });
    const service = await saveService(prov, { name: "Cut", durationMin: 30 });
    const { insertBookingRow } = await import("@/lib/bookings");
    const { db } = await import("@/lib/db");
    bookingId = await insertBookingRow(db(), {
      providerId: prov.id,
      customerId: cust.id,
      serviceId: service.id,
      serviceName: "Cut",
      startsAt,
      durationMin: 30,
      bufferBeforeMin: 0,
      bufferAfterMin: 0,
      providerTz: "UTC",
    });
  });

  afterAll(async () => {
    await sql`delete from booking where provider_id like 'ao-%'`;
    await sql`delete from "user" where id like 'ao-%'`;
    await sql.end();
  });

  it("returns counts to an admin and refuses everyone else", async () => {
    const { getAdminOverview, listUsers } = await import("@/lib/admin");
    const overview = await getAdminOverview(admin, NOW);
    expect(overview.providers).toBeGreaterThanOrEqual(1);
    expect(overview.bookings.confirmed).toBeGreaterThanOrEqual(1);
    expect(overview.chat.stepCap).toBe(400);
    // Counts only: nothing in the result is a booking, a note or a name.
    expect(JSON.stringify(overview)).not.toContain("Cora");
    await expect(getAdminOverview(prov, NOW)).rejects.toMatchObject({ status: 403 });
    await expect(listUsers(cust)).rejects.toMatchObject({ status: 403 });
    expect((await listUsers(admin)).some((u) => u.id === admin.id)).toBe(true);
  });

  it("gives the customer a cancel cutoff of start minus the minimum notice, and the provider the start", async () => {
    const { getBooking } = await import("@/lib/bookings");
    const asCustomer = await getBooking(cust, bookingId);
    expect(new Date(asCustomer.cancelBy).getTime()).toBe(startsAt.getTime() - 120 * 60_000);
    const asProvider = await getBooking(prov, bookingId);
    expect(new Date(asProvider.cancelBy).getTime()).toBe(startsAt.getTime());
  });
});
