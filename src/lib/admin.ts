import "server-only";
import { count, desc, eq, sql } from "drizzle-orm";
import { type Actor, ForbiddenError } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { DEMO_LOADS_PER_DAY } from "@/lib/demo";

/**
 * What the admin page shows: counts only. An admin sees how many providers, services and bookings exist and
 * how much of the app-wide daily caps is used, never a booking, a note or a chat message (those belong to their
 * two parties). The user list is the template's user management: name, email, role, join date.
 */

export type AdminUser = { id: string; name: string; email: string; role: string | null; createdAt: string };

export type AdminOverview = {
  users: number;
  admins: number;
  providers: number;
  acceptingProviders: number;
  services: number;
  bookings: { confirmed: number; cancelled: number; upcoming: number };
  chat: { turnsToday: number; stepsToday: number; stepCap: number };
  demo: { loadsToday: number; loadCap: number };
};

function assertAdmin(actor: Actor) {
  if (actor.role !== "admin") throw new ForbiddenError();
}

const n = (value: unknown) => Number(value ?? 0);

export async function getAdminOverview(actor: Actor, now = new Date()): Promise<AdminOverview> {
  assertAdmin(actor);
  const handle = db();
  const today = sql`(now() at time zone 'utc')::date`;
  const [[users], [admins], [providers], [accepting], [services], statuses, [upcoming], [turns], usage] = await Promise.all([
    handle.select({ n: count() }).from(schema.user),
    handle.select({ n: count() }).from(schema.user).where(eq(schema.user.role, "admin")),
    handle.select({ n: count() }).from(schema.providerProfile),
    handle.select({ n: count() }).from(schema.providerProfile).where(eq(schema.providerProfile.accepting, true)),
    handle.select({ n: count() }).from(schema.service),
    handle.select({ status: schema.booking.status, n: count() }).from(schema.booking).groupBy(schema.booking.status),
    handle
      .select({ n: count() })
      .from(schema.booking)
      .where(sql`${schema.booking.status} = 'confirmed' and ${schema.booking.startsAt} > ${now.toISOString()}::timestamptz`),
    // A turn stores one user message, so user messages created since UTC midnight are today's turns.
    handle
      .select({ n: count() })
      .from(schema.chatMessage)
      .where(sql`${schema.chatMessage.role} = 'user' and ${schema.chatMessage.createdAt} >= ${today}`),
    handle.select({ kind: schema.dailyUsage.kind, count: schema.dailyUsage.count }).from(schema.dailyUsage).where(sql`${schema.dailyUsage.day} = ${today}`),
  ]);
  const byStatus = new Map(statuses.map((row) => [row.status, n(row.n)]));
  const used = new Map(usage.map((row) => [row.kind, n(row.count)]));
  return {
    users: n(users.n),
    admins: n(admins.n),
    providers: n(providers.n),
    acceptingProviders: n(accepting.n),
    services: n(services.n),
    bookings: { confirmed: byStatus.get("confirmed") ?? 0, cancelled: byStatus.get("cancelled") ?? 0, upcoming: n(upcoming.n) },
    chat: { turnsToday: n(turns.n), stepsToday: used.get("chat_step") ?? 0, stepCap: env().CHAT_DAILY_CAP },
    demo: { loadsToday: used.get("demo_load") ?? 0, loadCap: DEMO_LOADS_PER_DAY },
  };
}

export async function listUsers(actor: Actor, limit = 100): Promise<AdminUser[]> {
  assertAdmin(actor);
  const rows = await db()
    .select({ id: schema.user.id, name: schema.user.name, email: schema.user.email, role: schema.user.role, createdAt: schema.user.createdAt })
    .from(schema.user)
    .orderBy(desc(schema.user.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

