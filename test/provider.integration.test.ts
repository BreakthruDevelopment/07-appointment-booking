/**
 * Provider setup and the booking exclusion constraints, against Postgres when TEST_DATABASE_URL is set.
 * Another user, including an admin, gets 404 on someone else's services and hours.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth/rbac";

const url = process.env.TEST_DATABASE_URL;

const alice: Actor = { id: "pv-alice", role: "user" };
const bob: Actor = { id: "pv-bob", role: "user" };
const admin: Actor = { id: "pv-admin", role: "admin" };
const cara: Actor = { id: "pv-cara", role: "user" };
const dave: Actor = { id: "pv-dave", role: "user" };
const cap: Actor = { id: "pv-cap", role: "user" };

function profileBody(slug: string) {
  return {
    slug,
    displayName: slug,
    bio: "",
    timeZone: "UTC",
    accepting: true,
    minNoticeMinutes: 0,
    horizonDays: 60,
  };
}

function sqlState(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === "string") return record.code;
    current = record.cause;
  }
  return undefined;
}

describe.skipIf(!url)("provider setup (Postgres)", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await sql`delete from booking where provider_id like 'pv-%' or customer_id like 'pv-%'`;
    await sql`delete from "user" where id like 'pv-%'`;
    for (const u of [alice, bob, admin, cara, dave, cap]) {
      await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@test.local"}, ${u.role})`;
    }
    const { upsertProfile } = await import("@/lib/provider");
    await upsertProfile(alice, profileBody("pv-alice"));
    await upsertProfile(bob, profileBody("pv-bob"));
    await upsertProfile(admin, profileBody("pv-admin"));
    await upsertProfile(dave, profileBody("pv-dave"));
  });

  afterAll(async () => {
    await sql`delete from booking where provider_id like 'pv-%' or customer_id like 'pv-%'`;
    await sql`delete from "user" where id like 'pv-%'`;
    await sql.end();
  });

  it("lets the owner change a service and answers 404 for another user and an admin", async () => {
    const { deleteService, getPublicProvider, saveService } = await import("@/lib/provider");
    const service = await saveService(alice, { name: "Cut", durationMin: 30, active: true });
    const stolen = { id: service.id, name: "Stolen", durationMin: 30 };
    await expect(saveService(bob, stolen)).rejects.toMatchObject({ status: 404 });
    await expect(saveService(admin, stolen)).rejects.toMatchObject({ status: 404 });
    await expect(deleteService(bob, service.id)).rejects.toMatchObject({ status: 404 });
    await expect(deleteService(admin, service.id)).rejects.toMatchObject({ status: 404 });

    const pub = await getPublicProvider("pv-alice");
    expect(pub?.displayName).toBe("pv-alice");
    expect(pub?.services.some((row) => row.id === service.id)).toBe(true);
    const body = JSON.stringify(pub);
    expect(body).not.toContain("userId");
    expect(body).not.toContain("@");

    await deleteService(alice, service.id);
  });

  it("answers 404 when hours include an id the caller does not own", async () => {
    const { listHours, replaceHours } = await import("@/lib/provider");
    const saved = await replaceHours(alice, { hours: [{ weekday: 1, startMin: 9 * 60, endMin: 12 * 60 }] });
    const foreign = { hours: [{ id: saved[0]?.id, weekday: 2, startMin: 9 * 60, endMin: 12 * 60 }] };
    await expect(replaceHours(bob, foreign)).rejects.toMatchObject({ status: 404 });
    await expect(replaceHours(admin, foreign)).rejects.toMatchObject({ status: 404 });
    const still = await listHours(alice);
    expect(still.map((row) => row.id)).toEqual([saved[0]?.id]);
    await replaceHours(alice, { hours: [] });
  });

  it("enforces the service cap, overlapping hours, reserved slugs, and taken slugs", async () => {
    const { replaceHours, saveService, upsertProfile } = await import("@/lib/provider");
    await upsertProfile(cap, profileBody("pv-cap"));
    for (let i = 0; i < 20; i++) await saveService(cap, { name: `Service ${i}`, durationMin: 30 });
    await expect(saveService(cap, { name: "One more", durationMin: 30 })).rejects.toMatchObject({ status: 409 });

    await expect(
      replaceHours(alice, {
        hours: [
          { weekday: 3, startMin: 9 * 60, endMin: 12 * 60 },
          { weekday: 3, startMin: 11 * 60, endMin: 13 * 60 },
        ],
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(upsertProfile(bob, profileBody("admin"))).rejects.toThrow(/reserved/);
    await expect(upsertProfile(bob, profileBody("pv-alice"))).rejects.toMatchObject({ status: 409 });
  });

  it("rejects overlapping confirmed bookings and allows a cancelled overlap", async () => {
    const { deleteService, replaceHours, saveService } = await import("@/lib/provider");
    const { availableSlots, loadAvailability } = await import("@/lib/availability");
    const aliceService = await saveService(alice, { name: "Consult", durationMin: 60, bufferBeforeMin: 15, bufferAfterMin: 15 });
    const daveService = await saveService(dave, { name: "Consult", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0 });

    const insertBooking = (row: {
      providerId: string;
      customerId: string;
      serviceId: string;
      starts: string;
      ends: string;
      blockedStart: string;
      blockedEnd: string;
      status?: string;
      cancelledBy?: string | null;
      cancelledAt?: string | null;
    }) =>
      sql`
        insert into booking (
          provider_id, customer_id, service_id, starts_at, ends_at, slot, blocked,
          status, cancelled_by, cancelled_at, service_name, duration_min, provider_tz
        ) values (
          ${row.providerId}, ${row.customerId}, ${row.serviceId}::uuid,
          ${row.starts}::timestamptz, ${row.ends}::timestamptz,
          tstzrange(${row.starts}::timestamptz, ${row.ends}::timestamptz, '[)'),
          tstzrange(${row.blockedStart}::timestamptz, ${row.blockedEnd}::timestamptz, '[)'),
          ${row.status ?? "confirmed"}, ${row.cancelledBy ?? null}, ${row.cancelledAt ?? null}::timestamptz,
          'Consult', 60, 'UTC'
        )
      `;

    await insertBooking({
      providerId: alice.id,
      customerId: bob.id,
      serviceId: aliceService.id,
      starts: "2026-06-15T09:00:00Z",
      ends: "2026-06-15T10:00:00Z",
      blockedStart: "2026-06-15T08:45:00Z",
      blockedEnd: "2026-06-15T10:15:00Z",
    });

    const overlapProvider = insertBooking({
      providerId: alice.id,
      customerId: cara.id,
      serviceId: aliceService.id,
      starts: "2026-06-15T09:30:00Z",
      ends: "2026-06-15T10:30:00Z",
      blockedStart: "2026-06-15T09:15:00Z",
      blockedEnd: "2026-06-15T10:45:00Z",
    });
    await expect(overlapProvider).rejects.toSatisfy((err: unknown) => sqlState(err) === "23P01");

    const overlapCustomer = insertBooking({
      providerId: dave.id,
      customerId: bob.id,
      serviceId: daveService.id,
      starts: "2026-06-15T09:30:00Z",
      ends: "2026-06-15T10:30:00Z",
      blockedStart: "2026-06-15T09:30:00Z",
      blockedEnd: "2026-06-15T10:30:00Z",
    });
    await expect(overlapCustomer).rejects.toSatisfy((err: unknown) => sqlState(err) === "23P01");

    await insertBooking({
      providerId: alice.id,
      customerId: cara.id,
      serviceId: aliceService.id,
      starts: "2026-06-15T09:30:00Z",
      ends: "2026-06-15T10:30:00Z",
      blockedStart: "2026-06-15T09:15:00Z",
      blockedEnd: "2026-06-15T10:45:00Z",
      status: "cancelled",
      cancelledBy: "customer",
      cancelledAt: "2026-06-14T12:00:00Z",
    });

    await insertBooking({
      providerId: alice.id,
      customerId: cara.id,
      serviceId: aliceService.id,
      starts: "2026-06-15T13:00:00Z",
      ends: "2026-06-15T14:00:00Z",
      blockedStart: "2026-06-15T12:45:00Z",
      blockedEnd: "2026-06-15T14:15:00Z",
    });

    await replaceHours(alice, {
      hours: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startMin: 0, endMin: 1440 })),
    });
    const loaded = await loadAvailability(alice.id, aliceService.id, new Date("2026-06-15T00:00:00Z"), new Date("2026-06-16T00:00:00Z"));
    expect(loaded).not.toBeNull();
    const starts = availableSlots({
      ...loaded!,
      from: new Date("2026-06-15T00:00:00Z"),
      to: new Date("2026-06-16T00:00:00Z"),
      now: new Date("2026-06-01T00:00:00Z"),
    }).map((slot) => slot.start.toISOString());
    expect(starts).not.toContain("2026-06-15T10:15:00.000Z");
    expect(starts).toContain("2026-06-15T10:30:00.000Z");

    await expect(loadAvailability(alice.id, "00000000-0000-4000-8000-000000000000", new Date("2026-06-15T00:00:00Z"), new Date("2026-06-16T00:00:00Z"))).resolves.toBeNull();
    await expect(deleteService(alice, aliceService.id)).rejects.toMatchObject({ status: 409 });
  });
});
