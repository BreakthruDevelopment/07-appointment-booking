import "server-only";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { todayInZone } from "@/lib/availability";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/errors";
import { log } from "@/lib/log";
import {
  MAX_SERVICES,
  type HoursInput,
  type ProfileInput,
  type ServiceInput,
  parseHours,
  parseOverrides,
  parseProfile,
  parseService,
} from "@/lib/provider-rules";
import { type Tx, advisoryLock } from "@/lib/usage";

/**
 * Provider setup. Every function takes the acting user. Provider rows are private to that user,
 * admin included, so a stranger's id is a 404 rather than a 403 (`assertCan` would let an admin through).
 * `assertCan(actor, "create")` only checks that a signed-in role may attempt the call.
 */

export type OwnerProfile = {
  slug: string;
  displayName: string;
  bio: string;
  timeZone: string;
  accepting: boolean;
  minNoticeMinutes: number;
  horizonDays: number;
};

export type OwnerService = {
  id: string;
  name: string;
  description: string;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  active: boolean;
  position: number;
};

export type PublicProvider = OwnerProfile & { services: OwnerService[] };

const profileColumns = {
  slug: schema.providerProfile.slug,
  displayName: schema.providerProfile.displayName,
  bio: schema.providerProfile.bio,
  timeZone: schema.providerProfile.timeZone,
  accepting: schema.providerProfile.accepting,
  minNoticeMinutes: schema.providerProfile.minNoticeMinutes,
  horizonDays: schema.providerProfile.horizonDays,
};

const serviceColumns = {
  id: schema.service.id,
  name: schema.service.name,
  description: schema.service.description,
  durationMin: schema.service.durationMin,
  bufferBeforeMin: schema.service.bufferBeforeMin,
  bufferAfterMin: schema.service.bufferAfterMin,
  active: schema.service.active,
  position: schema.service.position,
};

export async function getOwnProfile(actor: Actor): Promise<OwnerProfile> {
  assertCan(actor, "create");
  const [row] = await db().select(profileColumns).from(schema.providerProfile).where(eq(schema.providerProfile.userId, actor.id));
  if (!row) throw new NotFoundError("Set up your provider profile first.");
  return row;
}

export async function upsertProfile(actor: Actor, input: unknown): Promise<OwnerProfile> {
  assertCan(actor, "create");
  const data = parseProfile(input);
  await assertPgTimeZone(data.timeZone);
  try {
    const [row] = await db()
      .insert(schema.providerProfile)
      .values({ userId: actor.id, ...data })
      .onConflictDoUpdate({ target: schema.providerProfile.userId, set: data })
      .returning(profileColumns);
    log.info("provider.profile_saved", { userId: actor.id });
    return row;
  } catch (err) {
    if (pgCode(err) === "23505") throw new ConflictError("That link is already taken.");
    throw err;
  }
}

export async function getPublicProvider(slug: string): Promise<PublicProvider | null> {
  const [row] = await db()
    .select({ userId: schema.providerProfile.userId, ...profileColumns })
    .from(schema.providerProfile)
    .where(eq(schema.providerProfile.slug, slug));
  if (!row) return null;
  const { userId, ...profile } = row;
  const services = await db()
    .select(serviceColumns)
    .from(schema.service)
    .where(and(eq(schema.service.providerId, userId), eq(schema.service.active, true)))
    .orderBy(asc(schema.service.position), asc(schema.service.name));
  return { ...profile, services };
}

export async function listServices(actor: Actor): Promise<OwnerService[]> {
  assertCan(actor, "create");
  await requireProfile(actor);
  return db()
    .select(serviceColumns)
    .from(schema.service)
    .where(eq(schema.service.providerId, actor.id))
    .orderBy(asc(schema.service.position), asc(schema.service.name));
}

export async function saveService(actor: Actor, input: unknown): Promise<OwnerService> {
  assertCan(actor, "create");
  const data = parseService(input);
  return db().transaction(async (tx) => {
    await advisoryLock(tx, `services:${actor.id}`);
    await requireProfile(actor, tx);
    if (data.id) {
      const [existing] = await tx
        .select({ id: schema.service.id, position: schema.service.position })
        .from(schema.service)
        .where(and(eq(schema.service.id, data.id), eq(schema.service.providerId, actor.id)));
      if (!existing) throw new NotFoundError();
      const [row] = await tx
        .update(schema.service)
        .set(serviceValues(actor.id, data, data.position ?? existing.position))
        .where(eq(schema.service.id, data.id))
        .returning(serviceColumns);
      log.info("provider.service_saved", { userId: actor.id, serviceId: row.id });
      return row;
    }
    const [{ n }] = await tx.select({ n: count() }).from(schema.service).where(eq(schema.service.providerId, actor.id));
    if (Number(n) >= MAX_SERVICES) throw new ConflictError("A provider can have at most 20 services.");
    const [row] = await tx
      .insert(schema.service)
      .values(serviceValues(actor.id, data, data.position ?? Number(n)))
      .returning(serviceColumns);
    log.info("provider.service_saved", { userId: actor.id, serviceId: row.id });
    return row;
  });
}

export async function deleteService(actor: Actor, id: unknown): Promise<{ id: string }> {
  assertCan(actor, "create");
  const serviceId = z.uuid().parse(id);
  try {
    const [row] = await db()
      .delete(schema.service)
      .where(and(eq(schema.service.id, serviceId), eq(schema.service.providerId, actor.id)))
      .returning({ id: schema.service.id });
    if (!row) throw new NotFoundError();
    log.info("provider.service_deleted", { userId: actor.id, serviceId: row.id });
    return row;
  } catch (err) {
    if (err instanceof NotFoundError) throw err;
    if (pgCode(err) === "23503") throw new ConflictError("That service has bookings and can't be removed.");
    throw err;
  }
}

export async function listHours(actor: Actor) {
  assertCan(actor, "create");
  await requireProfile(actor);
  return db()
    .select({
      id: schema.weeklyHours.id,
      weekday: schema.weeklyHours.weekday,
      startMin: schema.weeklyHours.startMin,
      endMin: schema.weeklyHours.endMin,
    })
    .from(schema.weeklyHours)
    .where(eq(schema.weeklyHours.providerId, actor.id))
    .orderBy(asc(schema.weeklyHours.weekday), asc(schema.weeklyHours.startMin));
}

export async function replaceHours(actor: Actor, input: unknown) {
  assertCan(actor, "create");
  const data = parseHours(input);
  return db().transaction(async (tx) => {
    await advisoryLock(tx, `hours:${actor.id}`);
    await requireProfile(actor, tx);
    await assertOwnedHourIds(tx, actor, data);
    await tx.delete(schema.weeklyHours).where(eq(schema.weeklyHours.providerId, actor.id));
    if (data.hours.length === 0) return [];
    const rows = await tx
      .insert(schema.weeklyHours)
      .values(
        data.hours.map((hour) => ({
          providerId: actor.id,
          weekday: hour.weekday,
          startMin: hour.startMin,
          endMin: hour.endMin,
        })),
      )
      .returning({
        id: schema.weeklyHours.id,
        weekday: schema.weeklyHours.weekday,
        startMin: schema.weeklyHours.startMin,
        endMin: schema.weeklyHours.endMin,
      });
    log.info("provider.hours_saved", { userId: actor.id, count: rows.length });
    return rows.sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin);
  });
}

export async function listOverrides(actor: Actor) {
  assertCan(actor, "create");
  await requireProfile(actor);
  return db()
    .select({
      date: schema.dateOverride.date,
      closed: schema.dateOverride.closed,
      intervals: schema.dateOverride.intervals,
    })
    .from(schema.dateOverride)
    .where(eq(schema.dateOverride.providerId, actor.id))
    .orderBy(asc(schema.dateOverride.date));
}

export async function replaceOverrides(actor: Actor, input: unknown, now = new Date()) {
  assertCan(actor, "create");
  const profile = await requireProfile(actor);
  const data = parseOverrides(input, todayInZone(profile.timeZone, now));
  return db().transaction(async (tx) => {
    await advisoryLock(tx, `overrides:${actor.id}`);
    await tx.delete(schema.dateOverride).where(eq(schema.dateOverride.providerId, actor.id));
    if (data.overrides.length === 0) return [];
    const rows = await tx
      .insert(schema.dateOverride)
      .values(
        data.overrides.map((row) => ({
          providerId: actor.id,
          date: row.date,
          closed: row.closed,
          intervals: row.closed ? [] : row.intervals,
        })),
      )
      .returning({
        date: schema.dateOverride.date,
        closed: schema.dateOverride.closed,
        intervals: schema.dateOverride.intervals,
      });
    log.info("provider.overrides_saved", { userId: actor.id, count: rows.length });
    return rows.sort((a, b) => a.date.localeCompare(b.date));
  });
}

function serviceValues(providerId: string, data: ServiceInput, position: number) {
  return {
    providerId,
    name: data.name,
    description: data.description,
    durationMin: data.durationMin,
    bufferBeforeMin: data.bufferBeforeMin,
    bufferAfterMin: data.bufferAfterMin,
    active: data.active,
    position,
  };
}

async function requireProfile(actor: Actor, tx?: Tx): Promise<ProfileInput & { userId: string }> {
  const handle = tx ?? db();
  const [row] = await handle
    .select({
      userId: schema.providerProfile.userId,
      ...profileColumns,
    })
    .from(schema.providerProfile)
    .where(eq(schema.providerProfile.userId, actor.id));
  if (!row) throw new NotFoundError("Set up your provider profile first.");
  return row;
}

async function assertOwnedHourIds(tx: Tx, actor: Actor, data: HoursInput) {
  const ids = [...new Set(data.hours.flatMap((hour) => (hour.id ? [hour.id] : [])))];
  if (ids.length === 0) return;
  const rows = await tx
    .select({ id: schema.weeklyHours.id })
    .from(schema.weeklyHours)
    .where(and(eq(schema.weeklyHours.providerId, actor.id), inArray(schema.weeklyHours.id, ids)));
  if (rows.length !== ids.length) throw new NotFoundError();
}

async function assertPgTimeZone(timeZone: string) {
  const rows = await db().execute<{ ok: number }>(sql`select 1 as ok from pg_timezone_names where name = ${timeZone} limit 1`);
  if (rows.length === 0) throw new BadRequestError("Unknown time zone.");
}

function pgCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === "string" && /^[0-9A-Z]{5}$/.test(record.code)) return record.code;
    current = record.cause;
  }
  return undefined;
}
