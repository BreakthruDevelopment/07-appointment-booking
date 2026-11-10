import "server-only";
import { and, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { availableSlots, loadAvailability } from "@/lib/availability";
import { type BookingView, cancelBooking, createBooking } from "@/lib/bookings";
import { db, schema } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { log } from "@/lib/log";
import { ownedBy } from "@/lib/owned";
import { type Tx, advisoryLock } from "@/lib/usage";

/**
 * Proposals: the only thing the assistant can write. A proposal is a row that says "this customer may be
 * asked to confirm this exact booking (or cancellation)". It books nothing.
 *
 * Confirming is a normal customer action (`POST /api/bookings { proposalId }`). `confirmProposal` claims the
 * row atomically (owner, unexpired, unused), then runs `createBooking` / `cancelBooking` with the values
 * STORED on the row. Nothing the client or the model says at that point can change what is booked, and every
 * normal check (re-validated availability, limits, the exclusion constraints) still applies.
 */

export const PROPOSAL_TTL_MS = 10 * 60_000;

export type ProposalView = {
  id: string;
  kind: "book" | "cancel";
  /** `open` can still be confirmed; `used` was confirmed (or is being); `expired` timed out or was dismissed. */
  status: "open" | "used" | "expired";
  serviceName: string | null;
  durationMin: number | null;
  startsAt: string | null;
  endsAt: string | null;
  providerName: string;
  providerTz: string;
  expiresAt: string;
};

export type ProposalScope = { actor: Actor; threadId: string; providerId: string };

/**
 * Boundary schemas for every exported data function here: parsed before any query runs. Ids are uuids (user ids
 * are Better Auth's text ids, so those are bounded strings), instants are a valid Date or an ISO datetime WITH an
 * offset, and nothing is unbounded.
 */
const idText = z.string().min(1).max(128);
const instant = z.union([
  z.date().refine((d) => !Number.isNaN(d.getTime()), "Invalid date"),
  z.iso.datetime({ offset: true }).transform((s) => new Date(s)),
]);
const scopeSchema = z.object({
  actor: z.object({ id: idText, role: z.enum(["user", "admin"]) }),
  threadId: z.uuid(),
  providerId: idText,
});
const bookInputSchema = z.object({ serviceId: z.uuid(), startsAt: instant }).strict();
const idListSchema = z.array(z.uuid()).max(100);

function parseScope(scope: ProposalScope): ProposalScope {
  // Validate the shape, keep the caller's actor object (it is the authority for assertCan and ownership checks).
  const parsed = scopeSchema.parse(scope);
  return { actor: scope.actor, threadId: parsed.threadId, providerId: parsed.providerId };
}

/** Make `starts_at` a proposal can name: it must be a start the engine offers right now and is still free. */
async function assertOffered(providerId: string, serviceId: string, startsAt: Date, now: Date): Promise<void> {
  const window = { from: startsAt, to: new Date(startsAt.getTime() + 60_000) };
  const loaded = await loadAvailability(providerId, serviceId, window.from, window.to);
  if (!loaded || !loaded.profile.accepting || !loaded.service.active) throw new NotFoundError("That service doesn't exist.");
  const free = availableSlots({ ...loaded, ...window, now }).some((slot) => slot.start.getTime() === startsAt.getTime());
  if (!free) throw new ConflictError("That time isn't available any more.", { code: "slot_unavailable" });
}

/** Older open proposals in the thread stop being confirmable once a newer one is made: the latest card wins. */
async function supersedeOpen(scope: ProposalScope, now: Date, tx: Tx, signal?: AbortSignal) {
  // One writer per thread at a time, so two concurrent proposals can't both stay open: the second waits, then
  // supersedes the first. (Transaction-scoped; released at commit.)
  await advisoryLock(tx, `proposal:thread:${scope.threadId}`);
  // A handler whose turn already timed out may only get the lock now. It must not expire the customer's
  // current card or add a proposal nobody will see: throwing here rolls the transaction back.
  signal?.throwIfAborted();
  await tx
    .update(schema.bookingProposal)
    .set({ expiresAt: now })
    .where(
      and(
        eq(schema.bookingProposal.threadId, scope.threadId),
        ownedBy({ ownerId: schema.bookingProposal.customerId }, scope.actor),
        isNull(schema.bookingProposal.usedAt),
        gt(schema.bookingProposal.expiresAt, now),
      ),
    );
}

/** Propose booking `serviceId` at `startsAt`. The service must be this provider's: a foreign id is a 404. */
export async function createBookProposal(
  rawScope: ProposalScope,
  rawInput: { serviceId: string; startsAt: Date | string },
  rawNow: Date,
  signal?: AbortSignal,
): Promise<{ id: string; serviceName: string; startsAt: Date; expiresAt: Date }> {
  assertCan(rawScope.actor, "create");
  const scope = parseScope(rawScope);
  const input = bookInputSchema.parse(rawInput);
  const now = instant.parse(rawNow);
  signal?.throwIfAborted();
  if (scope.providerId === scope.actor.id) throw new ConflictError("You can't book your own services.");
  const [service] = await db()
    .select({ name: schema.service.name })
    .from(schema.service)
    .where(and(eq(schema.service.id, input.serviceId), eq(schema.service.providerId, scope.providerId), eq(schema.service.active, true)));
  if (!service) throw new NotFoundError("That service doesn't exist.");
  await assertOffered(scope.providerId, input.serviceId, input.startsAt, now);
  signal?.throwIfAborted();

  const expiresAt = new Date(now.getTime() + PROPOSAL_TTL_MS);
  const id = await db().transaction(async (tx) => {
    await supersedeOpen(scope, now, tx, signal);
    const [row] = await tx
      .insert(schema.bookingProposal)
      .values({
        threadId: scope.threadId,
        customerId: scope.actor.id,
        kind: "book",
        serviceId: input.serviceId,
        startsAt: input.startsAt,
        expiresAt,
      })
      .returning({ id: schema.bookingProposal.id });
    return row.id;
  });
  return { id, serviceName: service.name, startsAt: input.startsAt, expiresAt };
}

/**
 * Propose cancelling one of the actor's own confirmed, future bookings with this provider. Anyone else's
 * booking (or a made-up id) is a 404, exactly as for the cancel route.
 */
export async function createCancelProposal(
  rawScope: ProposalScope,
  rawBookingId: string,
  rawNow: Date,
  signal?: AbortSignal,
): Promise<{ id: string; serviceName: string; startsAt: Date; expiresAt: Date }> {
  assertCan(rawScope.actor, "create");
  const scope = parseScope(rawScope);
  const bookingId = z.uuid().parse(rawBookingId);
  const now = instant.parse(rawNow);
  signal?.throwIfAborted();
  const [row] = await db()
    .select({
      id: schema.booking.id,
      serviceName: schema.booking.serviceName,
      startsAt: schema.booking.startsAt,
      minNoticeMinutes: schema.providerProfile.minNoticeMinutes,
    })
    .from(schema.booking)
    .innerJoin(schema.providerProfile, eq(schema.providerProfile.userId, schema.booking.providerId))
    .where(
      ownedBy(
        { ownerId: schema.booking.customerId },
        scope.actor,
        eq(schema.booking.id, bookingId),
        eq(schema.booking.providerId, scope.providerId),
        eq(schema.booking.status, "confirmed"),
        gt(schema.booking.startsAt, now),
      ),
    );
  if (!row) throw new NotFoundError();
  if (now.getTime() > row.startsAt.getTime() - row.minNoticeMinutes * 60_000) {
    throw new ConflictError("It's too close to the appointment to cancel online. Contact the provider.", { code: "cancellation_closed" });
  }
  const expiresAt = new Date(now.getTime() + PROPOSAL_TTL_MS);
  const id = await db().transaction(async (tx) => {
    await supersedeOpen(scope, now, tx, signal);
    const [created] = await tx
      .insert(schema.bookingProposal)
      .values({ threadId: scope.threadId, customerId: scope.actor.id, kind: "cancel", bookingId: row.id, expiresAt })
      .returning({ id: schema.bookingProposal.id });
    return created.id;
  });
  return { id, serviceName: row.serviceName, startsAt: row.startsAt, expiresAt };
}

/** The one schema for a proposal id, at every boundary (routes and data functions). */
export const proposalIdSchema = z.uuid();

/** A malformed id can't be anyone's proposal: 404, the same answer as for someone else's. */
export function parseProposalId(id: unknown): string {
  const parsed = proposalIdSchema.safeParse(id);
  if (!parsed.success) throw new NotFoundError();
  return parsed.data.toLowerCase();
}
const parseUuid = parseProposalId;

/**
 * Confirm a proposal: the customer's tap on the card. Single use, owner only.
 *
 * 404 not yours (or no such proposal), 409 `proposal_used`, 409 `proposal_expired`, plus whatever
 * `createBooking` / `cancelBooking` answer (409 `slot_unavailable` / `slot_taken` with fresh `slots`,
 * `limit_reached`, `cancellation_closed`; 429). If the booking or cancellation is refused the claim is
 * released, so the customer can try the same card again (it still expires after 10 minutes) and no booking
 * was made; if it succeeds the row stays used for good.
 */
export async function confirmProposal(
  actor: Actor,
  proposalId: unknown,
  now = new Date(),
): Promise<{ action: "booked" | "cancelled"; booking: BookingView }> {
  assertCan(actor, "create");
  const id = parseUuid(proposalId);
  now = instant.parse(now);
  const owner = ownedBy({ ownerId: schema.bookingProposal.customerId }, actor, eq(schema.bookingProposal.id, id));

  const [claimed] = await db()
    .update(schema.bookingProposal)
    .set({ usedAt: now })
    .where(and(owner, isNull(schema.bookingProposal.usedAt), gt(schema.bookingProposal.expiresAt, now)))
    .returning();
  if (!claimed) {
    const [existing] = await db().select().from(schema.bookingProposal).where(owner);
    if (!existing) throw new NotFoundError();
    if (existing.usedAt) throw new ConflictError("That confirmation was already used.", { code: "proposal_used" });
    throw new ConflictError("That confirmation expired. Ask the assistant again.", { code: "proposal_expired" });
  }

  // Under the same per-thread lock as making a proposal. If a newer card was made while this one was claimed
  // (supersedeOpen skipped it because it was claimed), reopening would leave two open cards: expire this one.
  const release = () =>
    db()
      .transaction(async (tx) => {
        await advisoryLock(tx, `proposal:thread:${claimed.threadId}`);
        const [newer] = await tx
          .select({ id: schema.bookingProposal.id })
          .from(schema.bookingProposal)
          .where(
            and(
              eq(schema.bookingProposal.threadId, claimed.threadId),
              ownedBy({ ownerId: schema.bookingProposal.customerId }, actor),
              ne(schema.bookingProposal.id, id),
              isNull(schema.bookingProposal.usedAt),
              gt(schema.bookingProposal.expiresAt, now),
            ),
          )
          .limit(1);
        await tx
          .update(schema.bookingProposal)
          .set(newer ? { usedAt: null, expiresAt: now } : { usedAt: null })
          .where(and(owner, eq(schema.bookingProposal.usedAt, now)));
      })
      .then(() => undefined, () => undefined);

  let result: { action: "booked" | "cancelled"; booking: BookingView };
  try {
    if (claimed.kind === "book") {
      if (!claimed.serviceId || !claimed.startsAt) throw new ConflictError("That service is no longer offered.", { code: "proposal_invalid" });
      const [thread] = await db()
        .select({ providerId: schema.chatThread.providerId })
        .from(schema.chatThread)
        .where(and(eq(schema.chatThread.id, claimed.threadId), eq(schema.chatThread.customerId, actor.id)));
      const [service] = await db()
        .select({ providerId: schema.service.providerId })
        .from(schema.service)
        .where(eq(schema.service.id, claimed.serviceId));
      // The proposal was made on this provider's page; a service that is somehow someone else's is never booked.
      if (!thread || !service || thread.providerId !== service.providerId) throw new NotFoundError();
      // The stored values, not the request's: createBooking re-validates them against live availability.
      const booking = await createBooking(actor, { serviceId: claimed.serviceId, startsAt: claimed.startsAt.toISOString() }, now);
      result = { action: "booked", booking };
    } else {
      if (!claimed.bookingId) throw new ConflictError("That booking no longer exists.", { code: "proposal_invalid" });
      result = { action: "cancelled", booking: await cancelBooking(actor, claimed.bookingId, now) };
    }
  } catch (err) {
    await release();
    throw err;
  }
  if (result.action === "booked") {
    // Audit trail; the claim already makes the row single-use, so a failure here must not undo the booking.
    await db()
      .update(schema.bookingProposal)
      .set({ bookingId: result.booking.id })
      .where(owner)
      .then(() => undefined, (err: unknown) => log.warn("proposal.link_failed", { proposalId: id, kind: (err as Error)?.name }));
  }
  log.info("proposal.confirmed", { proposalId: id, kind: claimed.kind, bookingId: result.booking.id });
  return result;
}

/** Close proposals this turn made but must not show (their cards were never sent). Only the actor's own, still open. */
export async function discardProposals(actor: Actor, rawIds: string[], rawNow: Date): Promise<void> {
  assertCan(actor, "create");
  const ids = idListSchema.parse(rawIds);
  const now = instant.parse(rawNow);
  if (ids.length === 0) return;
  await db()
    .update(schema.bookingProposal)
    .set({ expiresAt: now })
    .where(and(ownedBy({ ownerId: schema.bookingProposal.customerId }, actor), inArray(schema.bookingProposal.id, ids), isNull(schema.bookingProposal.usedAt), gt(schema.bookingProposal.expiresAt, now)));
}

/** "Not now": the customer closes a card. Idempotent; only the owner's open proposal changes. */
export async function dismissProposal(actor: Actor, proposalId: unknown, now = new Date()): Promise<{ id: string }> {
  assertCan(actor, "create");
  const id = parseUuid(proposalId);
  now = instant.parse(now);
  const [row] = await db()
    .select({ id: schema.bookingProposal.id })
    .from(schema.bookingProposal)
    .where(ownedBy({ ownerId: schema.bookingProposal.customerId }, actor, eq(schema.bookingProposal.id, id)));
  if (!row) throw new NotFoundError();
  await db()
    .update(schema.bookingProposal)
    .set({ expiresAt: now })
    .where(
      ownedBy({ ownerId: schema.bookingProposal.customerId }, actor, eq(schema.bookingProposal.id, id), isNull(schema.bookingProposal.usedAt), gt(schema.bookingProposal.expiresAt, now)),
    );
  return { id };
}

/** Cards for the proposals with these ids, rebuilt from the rows (never from model text). Only the actor's own. */
export async function proposalViews(actor: Actor, rawIds: string[], rawNow = new Date()): Promise<Map<string, ProposalView>> {
  assertCan(actor, "create");
  const now = instant.parse(rawNow);
  const out = new Map<string, ProposalView>();
  const unique = [...new Set(idListSchema.parse(rawIds))];
  if (unique.length === 0) return out;
  const rows = await db()
    .select({
      p: schema.bookingProposal,
      providerName: schema.providerProfile.displayName,
      providerTz: schema.providerProfile.timeZone,
      svcName: schema.service.name,
      svcDuration: schema.service.durationMin,
      bkName: schema.booking.serviceName,
      bkStart: schema.booking.startsAt,
      bkEnd: schema.booking.endsAt,
      bkDuration: schema.booking.durationMin,
      bkTz: schema.booking.providerTz,
    })
    .from(schema.bookingProposal)
    .innerJoin(schema.chatThread, and(eq(schema.chatThread.id, schema.bookingProposal.threadId), eq(schema.chatThread.customerId, schema.bookingProposal.customerId)))
    .innerJoin(schema.providerProfile, eq(schema.providerProfile.userId, schema.chatThread.providerId))
    .leftJoin(schema.service, eq(schema.service.id, schema.bookingProposal.serviceId))
    .leftJoin(schema.booking, and(eq(schema.booking.id, schema.bookingProposal.bookingId), eq(schema.booking.customerId, schema.bookingProposal.customerId)))
    .where(and(ownedBy({ ownerId: schema.bookingProposal.customerId }, actor), inArray(schema.bookingProposal.id, unique)));
  for (const r of rows) {
    const status: ProposalView["status"] = r.p.usedAt ? "used" : r.p.expiresAt.getTime() > now.getTime() ? "open" : "expired";
    const book = r.p.kind === "book";
    const startsAt = book ? r.p.startsAt : r.bkStart;
    const durationMin = book ? r.svcDuration : r.bkDuration;
    out.set(r.p.id, {
      id: r.p.id,
      kind: r.p.kind,
      status,
      serviceName: book ? r.svcName : r.bkName,
      durationMin: durationMin ?? null,
      startsAt: startsAt ? startsAt.toISOString() : null,
      endsAt: startsAt && durationMin ? new Date(startsAt.getTime() + durationMin * 60_000).toISOString() : null,
      providerName: r.providerName,
      providerTz: book ? r.providerTz : (r.bkTz ?? r.providerTz),
      expiresAt: r.p.expiresAt.toISOString(),
    });
  }
  return out;
}

