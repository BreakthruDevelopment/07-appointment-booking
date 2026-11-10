import "server-only";
import { type SQL, and, asc, count, desc, eq, gt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { availableSlots, loadAvailability } from "@/lib/availability";
import { type Db, db, schema } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/errors";
import { buildCalendar } from "@/lib/ics";
import { log } from "@/lib/log";
import { ownedBy } from "@/lib/owned";
import { type Tx, advisoryLock, consumeRate } from "@/lib/usage";

/**
 * Bookings. Every function takes the acting user.
 *
 * A booking is visible to exactly two people: its customer and its provider. Admins get no special
 * access (counts only, elsewhere), so `assertCan` is only the "signed in" gate and the real filter is
 * `ownedBy` on `customer_id` / `provider_id`: anyone else, an admin included, gets 404.
 *
 * No double booking: the guarantee is the database. `booking_provider_blocked_excl` and
 * `booking_customer_slot_excl` raise 23P01 on overlap; `createBooking` also re-validates the time against
 * current availability inside its transaction so a client can never book a time the engine wouldn't offer.
 */

export const BOOK_ATTEMPTS_PER_HOUR = 10;
export const MAX_UPCOMING_PER_PROVIDER = 3;
export const MAX_UPCOMING_OVERALL = 10;
export const FRESH_SLOT_COUNT = 12;
const TRANSIENT_RETRIES = 4;

const createInput = z
  .object({
    serviceId: z.uuid(),
    startsAt: z.iso.datetime({ offset: true }),
    note: z.string().trim().max(300).optional(),
  })
  .strict();

const listInput = z.object({
  as: z.enum(["customer", "provider"]).default("customer"),
  when: z.enum(["upcoming", "past", "all"]).default("upcoming"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type BookingView = {
  id: string;
  /** Which side the viewer is on. */
  role: "customer" | "provider";
  serviceId: string;
  serviceName: string;
  durationMin: number;
  startsAt: string;
  endsAt: string;
  providerTz: string;
  providerName: string;
  providerSlug: string;
  /** Only the provider sees who booked, and only the name they gave (never an email). */
  customerName: string | null;
  customerNote: string | null;
  status: "confirmed" | "cancelled";
  cancelledBy: "customer" | "provider" | null;
  cancelledAt: string | null;
  sequence: number;
  createdAt: string;
};

type Reader = Pick<Db, "select">;

const viewColumns = {
  id: schema.booking.id,
  providerId: schema.booking.providerId,
  customerId: schema.booking.customerId,
  serviceId: schema.booking.serviceId,
  serviceName: schema.booking.serviceName,
  durationMin: schema.booking.durationMin,
  startsAt: schema.booking.startsAt,
  endsAt: schema.booking.endsAt,
  providerTz: schema.booking.providerTz,
  status: schema.booking.status,
  cancelledBy: schema.booking.cancelledBy,
  cancelledAt: schema.booking.cancelledAt,
  customerNote: schema.booking.customerNote,
  sequence: schema.booking.sequence,
  createdAt: schema.booking.createdAt,
  updatedAt: schema.booking.updatedAt,
  providerName: schema.providerProfile.displayName,
  providerSlug: schema.providerProfile.slug,
  customerName: schema.user.name,
  minNoticeMinutes: schema.providerProfile.minNoticeMinutes,
};


/** Rows the actor is a party to: the customer side or the provider side, nobody else. */
function partyOf(actor: Actor): SQL {
  return or(ownedBy({ ownerId: schema.booking.customerId }, actor), ownedBy({ ownerId: schema.booking.providerId }, actor)) as SQL;
}

function selectRows(reader: Reader, where: SQL) {
  return reader
    .select(viewColumns)
    .from(schema.booking)
    .innerJoin(schema.providerProfile, eq(schema.providerProfile.userId, schema.booking.providerId))
    .innerJoin(schema.user, eq(schema.user.id, schema.booking.customerId))
    .where(where);
}

type Row = Awaited<ReturnType<typeof selectRows>>[number];

function toView(row: Row, actor: Actor): BookingView {
  const role = row.providerId === actor.id ? "provider" : "customer";
  return {
    id: row.id,
    role,
    serviceId: row.serviceId,
    serviceName: row.serviceName,
    durationMin: row.durationMin,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    providerTz: row.providerTz,
    providerName: row.providerName,
    providerSlug: row.providerSlug,
    customerName: role === "provider" ? row.customerName : null,
    customerNote: row.customerNote,
    status: row.status,
    cancelledBy: row.cancelledBy,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    sequence: row.sequence,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function getBooking(actor: Actor, id: unknown): Promise<BookingView> {
  assertCan(actor, "create");
  const bookingId = parseId(id);
  const [row] = await selectRows(db(), and(eq(schema.booking.id, bookingId), partyOf(actor)) as SQL);
  if (!row) throw new NotFoundError();
  return toView(row, actor);
}

export async function listBookings(actor: Actor, input: unknown = {}, now = new Date()): Promise<BookingView[]> {
  assertCan(actor, "create");
  const query = listInput.parse(input);
  const side = ownedBy({ ownerId: query.as === "provider" ? schema.booking.providerId : schema.booking.customerId }, actor);
  const upcoming = gt(schema.booking.endsAt, now);
  const past = lte(schema.booking.endsAt, now);
  const where = and(side, query.when === "upcoming" ? upcoming : query.when === "past" ? past : undefined) as SQL;
  const rows = await selectRows(db(), where)
    .orderBy(query.when === "past" ? desc(schema.booking.startsAt) : asc(schema.booking.startsAt))
    .limit(query.limit);
  return rows.map((row) => toView(row, actor));
}

/**
 * Book a service at a time. The client's time is a request, not a fact: it is re-checked against the
 * provider's current hours, overrides, notice, horizon, buffers and existing bookings inside the
 * transaction, and the exclusion constraints decide any race.
 *
 * 409 `slot_unavailable`: the time was never on offer (hours, notice, horizon, step). 409 `slot_taken`:
 * it was on offer and someone (or the customer's own booking) holds it now. Both carry fresh `slots`.
 * 409 `limit_reached`: too many upcoming bookings. 429: too many attempts this hour.
 */
export async function createBooking(actor: Actor, input: unknown, now = new Date()): Promise<BookingView> {
  assertCan(actor, "create");
  const data = createInput.parse(input);
  const startsAt = new Date(data.startsAt);

  // Attempts count even when they fail, so this commits on its own before the booking transaction.
  await db().transaction((tx) => consumeRate(tx, actor.id, "book", BOOK_ATTEMPTS_PER_HOUR, "Too many booking attempts. Try again in an hour."));

  let providerId: string | undefined;
  const attempt = () =>
    db().transaction(async (tx) => {
      // One customer's bookings are serialised so the upcoming-booking caps can't be raced past.
      await advisoryLock(tx, `booking:customer:${actor.id}`);

      // Lock the provider profile, then the service, against edits until this transaction ends (always in that
      // order, which provider.ts also uses, so the two can't deadlock): a provider who closes the slot or
      // changes the service mid-booking waits for us, so the re-check below stays true at commit.
      const [found] = await tx.select({ providerId: schema.service.providerId }).from(schema.service).where(eq(schema.service.id, data.serviceId));
      if (!found) throw new NotFoundError("That service doesn't exist.");
      providerId = found.providerId;
      if (providerId === actor.id) throw new BadRequestError("You can't book your own services.");
      await tx.select({ id: schema.providerProfile.userId }).from(schema.providerProfile).where(eq(schema.providerProfile.userId, providerId)).for("share");
      const [owner] = await tx
        .select({ providerId: schema.service.providerId })
        .from(schema.service)
        .where(and(eq(schema.service.id, data.serviceId), eq(schema.service.providerId, providerId)))
        .for("share");
      if (!owner) throw new NotFoundError("That service doesn't exist.");

      const window = { from: startsAt, to: new Date(startsAt.getTime() + 60_000) };
      const loaded = await loadAvailability(providerId, data.serviceId, window.from, window.to, tx);
      if (!loaded || !loaded.profile.accepting) throw new NotFoundError("That service doesn't exist.");

      const isStart = (slot: { start: Date }) => slot.start.getTime() === startsAt.getTime();
      const offered = availableSlots({ ...loaded, ...window, busy: [], now }).some(isStart);
      if (!offered) throw new SlotError("slot_unavailable", "That time isn't available for this service.");
      const free = availableSlots({ ...loaded, ...window, now }).some(isStart);
      if (!free) throw new SlotError("slot_taken", "That time was just taken.");

      const [perProvider] = await tx
        .select({ n: count() })
        .from(schema.booking)
        .where(
          and(
            ownedBy({ ownerId: schema.booking.customerId }, actor),
            eq(schema.booking.providerId, providerId),
            eq(schema.booking.status, "confirmed"),
            gt(schema.booking.startsAt, now),
          ),
        );
      if (Number(perProvider.n) >= MAX_UPCOMING_PER_PROVIDER) {
        throw new ConflictError(`You can have at most ${MAX_UPCOMING_PER_PROVIDER} upcoming bookings with one provider.`, { code: "limit_reached" });
      }
      const [overall] = await tx
        .select({ n: count() })
        .from(schema.booking)
        .where(and(ownedBy({ ownerId: schema.booking.customerId }, actor), eq(schema.booking.status, "confirmed"), gt(schema.booking.startsAt, now)));
      if (Number(overall.n) >= MAX_UPCOMING_OVERALL) {
        throw new ConflictError(`You can have at most ${MAX_UPCOMING_OVERALL} upcoming bookings.`, { code: "limit_reached" });
      }

      const id = await insertBookingRow(tx, {
        providerId,
        customerId: actor.id,
        serviceId: data.serviceId,
        serviceName: await serviceName(tx, data.serviceId),
        startsAt,
        durationMin: loaded.service.durationMin,
        bufferBeforeMin: loaded.service.bufferBeforeMin,
        bufferAfterMin: loaded.service.bufferAfterMin,
        providerTz: loaded.profile.timeZone,
        note: data.note || null,
      });
      const [row] = await selectRows(tx, eq(schema.booking.id, id));
      log.info("booking.created", { bookingId: id, providerId, customerId: actor.id });
      return toView(row, actor);
    });
  try {
    // Two exclusion constraints can deadlock when many inserts race (Postgres aborts one with 40P01). The
    // loser has done nothing yet, so it retries: the next pass sees the winner's booking and answers 409.
    for (let tries = 1; ; tries++) {
      try {
        return await attempt();
      } catch (err) {
        const code = pgError(err)?.code;
        if ((code === "40P01" || code === "40001") && tries < TRANSIENT_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, 10 * tries + Math.random() * 20));
          continue;
        }
        if (code === "40P01" || code === "40001") throw new SlotError("slot_taken", "That time was just taken.");
        throw err;
      }
    }
  } catch (err) {
    if (providerId && (err instanceof SlotError || pgError(err)?.code === "23P01")) {
      const own = pgError(err)?.constraint === "booking_customer_slot_excl";
      const code = err instanceof SlotError ? err.code : "slot_taken";
      const message = err instanceof SlotError ? err.message : own ? "You already have a booking at that time." : "That time was just taken.";
      log.info("booking.conflict", { providerId, customerId: actor.id, code });
      throw new ConflictError(message, { code, slots: await freshSlots(providerId, data.serviceId, startsAt, now) });
    }
    throw err;
  }
}

/**
 * Cancel a booking. The customer may cancel until `starts_at − min_notice`; the provider any time before it
 * starts. Cancelling a cancelled booking returns it unchanged (idempotent, `sequence` isn't bumped twice).
 * Another user, an admin included, gets 404.
 */
export async function cancelBooking(actor: Actor, id: unknown, now = new Date()): Promise<BookingView> {
  assertCan(actor, "create");
  const bookingId = parseId(id);
  return db().transaction(async (tx) => {
    // `for update` makes two simultaneous cancels take turns, so the second sees the first's result.
    const [row] = await tx
      .select(viewColumns)
      .from(schema.booking)
      .innerJoin(schema.providerProfile, eq(schema.providerProfile.userId, schema.booking.providerId))
      .innerJoin(schema.user, eq(schema.user.id, schema.booking.customerId))
      .where(and(eq(schema.booking.id, bookingId), partyOf(actor)))
      .for("update", { of: schema.booking });
    if (!row) throw new NotFoundError();
    if (row.status === "cancelled") return toView(row, actor);

    const byProvider = row.providerId === actor.id;
    if (row.startsAt.getTime() <= now.getTime()) {
      throw new ConflictError("That appointment has already started.", { code: "already_started" });
    }
    if (!byProvider) {
      const cutoff = row.startsAt.getTime() - row.minNoticeMinutes * 60_000;
      if (now.getTime() > cutoff) {
        throw new ConflictError("It's too close to the appointment to cancel online. Contact the provider.", { code: "cancellation_closed" });
      }
    }

    await tx
      .update(schema.booking)
      .set({
        status: "cancelled",
        cancelledBy: byProvider ? "provider" : "customer",
        cancelledAt: now,
        sequence: sql`${schema.booking.sequence} + 1`,
        updatedAt: now,
      })
      .where(and(eq(schema.booking.id, bookingId), eq(schema.booking.status, "confirmed")));
    const [updated] = await selectRows(tx, eq(schema.booking.id, bookingId));
    log.info("booking.cancelled", { bookingId, by: byProvider ? "provider" : "customer" });
    return toView(updated, actor);
  });
}

/** One booking as a calendar file, from the viewer's side (the provider sees the customer's first name only). */
export async function getBookingIcs(actor: Actor, id: unknown): Promise<{ filename: string; body: string }> {
  assertCan(actor, "create");
  const bookingId = parseId(id);
  const [row] = await selectRows(db(), and(eq(schema.booking.id, bookingId), partyOf(actor)) as SQL);
  if (!row) throw new NotFoundError();
  const view = toView(row, actor);
  const summary =
    view.role === "provider" ? `${view.serviceName} - ${firstName(row.customerName)}` : `${view.serviceName} with ${view.providerName}`;
  const body = buildCalendar({
    events: [
      {
        id: view.id,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        summary,
        status: view.status,
        sequence: view.sequence,
        stamp: row.updatedAt,
      },
    ],
  });
  return { filename: `booking-${view.id.slice(0, 8)}.ics`, body };
}

/** The customer's first name only: what a provider's calendar shows. */
export function firstName(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? "";
  return first.slice(0, 40) || "Customer";
}

export type NewBookingRow = {
  providerId: string;
  customerId: string;
  serviceId: string;
  serviceName: string;
  startsAt: Date;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  providerTz: string;
  note?: string | null;
  cancelled?: { by: "customer" | "provider"; at: Date };
  createdAt?: Date;
};

/**
 * The one INSERT. `slot` and `blocked` are written together from the service's duration and buffers, so
 * the constraints and the availability engine use the same ranges. No validation here; callers decide.
 */
export async function insertBookingRow(tx: Pick<Db, "insert">, row: NewBookingRow): Promise<string> {
  const endsAt = new Date(row.startsAt.getTime() + row.durationMin * 60_000);
  const blockedStart = new Date(row.startsAt.getTime() - row.bufferBeforeMin * 60_000);
  const blockedEnd = new Date(endsAt.getTime() + row.bufferAfterMin * 60_000);
  const range = (a: Date, b: Date) => sql`tstzrange(${a.toISOString()}::timestamptz, ${b.toISOString()}::timestamptz, '[)')`;
  const [inserted] = await tx
    .insert(schema.booking)
    .values({
      providerId: row.providerId,
      customerId: row.customerId,
      serviceId: row.serviceId,
      startsAt: row.startsAt,
      endsAt,
      slot: range(row.startsAt, endsAt) as unknown as string,
      blocked: range(blockedStart, blockedEnd) as unknown as string,
      status: row.cancelled ? "cancelled" : "confirmed",
      cancelledBy: row.cancelled?.by ?? null,
      cancelledAt: row.cancelled?.at ?? null,
      sequence: row.cancelled ? 1 : 0,
      customerNote: row.note ?? null,
      serviceName: row.serviceName,
      durationMin: row.durationMin,
      providerTz: row.providerTz,
      ...(row.createdAt ? { createdAt: row.createdAt, updatedAt: row.createdAt } : {}),
    })
    .returning({ id: schema.booking.id });
  return inserted.id;
}

async function serviceName(tx: Tx, serviceId: string): Promise<string> {
  const [row] = await tx.select({ name: schema.service.name }).from(schema.service).where(eq(schema.service.id, serviceId));
  if (!row) throw new NotFoundError("That service doesn't exist.");
  return row.name;
}

/** Open starts near the contested time, so a 409 can offer alternatives without another request. */
async function freshSlots(providerId: string, serviceId: string, around: Date, now: Date): Promise<string[]> {
  const from = new Date(Math.max(now.getTime(), around.getTime() - 12 * 3_600_000));
  const to = new Date(from.getTime() + 3 * 86_400_000);
  const loaded = await loadAvailability(providerId, serviceId, from, to);
  if (!loaded) return [];
  return availableSlots({ ...loaded, from, to, now })
    .slice(0, FRESH_SLOT_COUNT)
    .map((slot) => slot.start.toISOString());
}

class SlotError extends ConflictError {
  constructor(
    readonly code: "slot_unavailable" | "slot_taken",
    message: string,
  ) {
    super(message, { code });
  }
}

function parseId(id: unknown): string {
  const parsed = z.uuid().safeParse(id);
  // A malformed id can't be anyone's booking.
  if (!parsed.success) throw new NotFoundError();
  return parsed.data;
}

export function pgError(err: unknown): { code?: string; constraint?: string } | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const record = current as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof record.code === "string" && /^[0-9A-Z]{5}$/.test(record.code)) {
      const constraint = record.constraint_name ?? record.constraint;
      return { code: record.code, constraint: typeof constraint === "string" ? constraint : undefined };
    }
    current = record.cause;
  }
  return undefined;
}
