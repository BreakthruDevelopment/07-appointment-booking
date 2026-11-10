import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gte, lte, or } from "drizzle-orm";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { firstName } from "@/lib/bookings";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { NotFoundError } from "@/lib/errors";
import { buildCalendar } from "@/lib/ics";
import { log } from "@/lib/log";
import { ownedBy } from "@/lib/owned";
import { consumeRate } from "@/lib/usage";

/**
 * The provider's private calendar feed. The URL carries a bearer token: 32 random bytes (base64url), shown
 * once and stored only as its sha256. Rotating replaces the hash, so the old URL stops working at once.
 * The feed holds confirmed bookings from 30 days back to 60 ahead plus bookings cancelled in the last 7 days,
 * with the service and the customer's first name only: no email, no note.
 */

export const FEED_ROTATIONS_PER_HOUR = 5;
export const FEED_PAST_DAYS = 30;
export const FEED_FUTURE_DAYS = 60;
export const FEED_CANCELLED_DAYS = 7;
const FEED_MAX_EVENTS = 500;
const DAY_MS = 86_400_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function feedUrl(token: string): string {
  return `${new URL(env().APP_URL).origin}/api/calendar/${token}.ics`;
}

/** Create the provider's feed token, or replace it. The only time the token is ever readable is this return value. */
export async function rotateFeedToken(actor: Actor): Promise<{ url: string; createdAt: string }> {
  assertCan(actor, "create");
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const createdAt = await db().transaction(async (tx) => {
    const [profile] = await tx
      .select({ userId: schema.providerProfile.userId })
      .from(schema.providerProfile)
      .where(ownedBy({ userId: schema.providerProfile.userId }, actor));
    if (!profile) throw new NotFoundError("Set up your provider profile first.");
    await consumeRate(tx, actor.id, "feed_rotate", FEED_ROTATIONS_PER_HOUR, "You've changed the calendar link too many times. Try again in an hour.");
    const now = new Date();
    await tx
      .insert(schema.calendarFeed)
      .values({ providerId: actor.id, tokenHash, createdAt: now })
      .onConflictDoUpdate({ target: schema.calendarFeed.providerId, set: { tokenHash, createdAt: now } });
    return now;
  });
  log.info("feed.rotated", { providerId: actor.id });
  return { url: feedUrl(token), createdAt: createdAt.toISOString() };
}

/** Whether a feed exists and when its link was made. Never the token (only its hash is stored). */
export async function getFeedStatus(actor: Actor): Promise<{ exists: boolean; createdAt: string | null }> {
  assertCan(actor, "create");
  const [row] = await db()
    .select({ createdAt: schema.calendarFeed.createdAt })
    .from(schema.calendarFeed)
    .where(ownedBy({ ownerId: schema.calendarFeed.providerId }, actor));
  return { exists: Boolean(row), createdAt: row ? row.createdAt.toISOString() : null };
}

/**
 * The feed for a token, or null for anything that doesn't match (malformed, unknown, rotated away).
 * The lookup is by sha256 of the token, so how long it takes reveals nothing about the token itself; the hash
 * is then compared again in constant time before the feed is built.
 */
export async function renderFeed(rawToken: string, now = new Date()): Promise<string | null> {
  const token = rawToken.endsWith(".ics") ? rawToken.slice(0, -4) : rawToken;
  if (!TOKEN_PATTERN.test(token)) return null;
  const presented = hashToken(token);
  const [feed] = await db()
    .select({ providerId: schema.calendarFeed.providerId, tokenHash: schema.calendarFeed.tokenHash })
    .from(schema.calendarFeed)
    .where(eq(schema.calendarFeed.tokenHash, presented));
  if (!feed) return null;
  if (!timingSafeEqual(Buffer.from(feed.tokenHash, "utf8"), Buffer.from(presented, "utf8"))) return null;

  const [profile] = await db()
    .select({ displayName: schema.providerProfile.displayName })
    .from(schema.providerProfile)
    .where(eq(schema.providerProfile.userId, feed.providerId));
  if (!profile) return null;

  const from = new Date(now.getTime() - FEED_PAST_DAYS * DAY_MS);
  const to = new Date(now.getTime() + FEED_FUTURE_DAYS * DAY_MS);
  const cancelledSince = new Date(now.getTime() - FEED_CANCELLED_DAYS * DAY_MS);
  const rows = await db()
    .select({
      id: schema.booking.id,
      startsAt: schema.booking.startsAt,
      endsAt: schema.booking.endsAt,
      serviceName: schema.booking.serviceName,
      status: schema.booking.status,
      sequence: schema.booking.sequence,
      updatedAt: schema.booking.updatedAt,
      customerName: schema.user.name,
    })
    .from(schema.booking)
    .innerJoin(schema.user, eq(schema.user.id, schema.booking.customerId))
    .where(
      and(
        eq(schema.booking.providerId, feed.providerId),
        or(
          and(eq(schema.booking.status, "confirmed"), gte(schema.booking.startsAt, from), lte(schema.booking.startsAt, to)),
          and(eq(schema.booking.status, "cancelled"), gte(schema.booking.cancelledAt, cancelledSince)),
        ),
      ),
    )
    .orderBy(asc(schema.booking.startsAt))
    .limit(FEED_MAX_EVENTS);

  return buildCalendar({
    name: `${profile.displayName} bookings`,
    events: rows.map((row) => ({
      id: row.id,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      summary: `${row.serviceName} - ${firstName(row.customerName)}`,
      status: row.status,
      sequence: row.sequence,
      stamp: row.updatedAt,
    })),
  });
}
