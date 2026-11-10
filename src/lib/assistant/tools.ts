import "server-only";
import { TZDate } from "@date-fns/tz";
import { asc, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { ToolError, defineTool } from "@/lib/ai";
import type { AnyToolDef } from "@/lib/ai/types";
import { assertCan } from "@/lib/auth/rbac";
import { availableSlots, loadAvailability, todayInZone } from "@/lib/availability";
import { db, schema } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { ownedBy } from "@/lib/owned";
import { type ProposalScope, createBookProposal, createCancelProposal } from "./proposals";
import { type PromptService, sanitizeText } from "./prompt";

/**
 * The assistant's tools. Built per request; the actor, provider and thread are bound HERE, in closures, and
 * no argument the model supplies can change them. Arguments are opaque references the server issued in THIS
 * turn (S1 = a service, A1 = a slot from the latest find_open_slots, B1 = one of the actor's bookings), plus
 * dates the server validates. There is deliberately no tool that creates or cancels a booking: propose tools
 * write a `booking_proposal` row and the customer confirms it with a tap (`confirmProposal`).
 */

export const MAX_SLOTS_PER_RESULT = 12;
export const MAX_WINDOW_DAYS = 7;
/** Every handler call counts, so a model can't spend the database on its own loop (the loop caps steps too). */
export const MAX_TOOL_CALLS_PER_TURN = 6;

const ymd = /^\d{4}-\d{2}-\d{2}$/;
const hm = /^([01]\d|2[0-3]):[0-5]\d$/;

const findArgs = z
  .object({
    service: z.string().regex(/^S\d{1,2}$/, "service is one of the S-references in the context, like S1"),
    fromDate: z.string().regex(ymd, "fromDate is YYYY-MM-DD in the customer's time zone"),
    toDate: z.string().regex(ymd, "toDate is YYYY-MM-DD in the customer's time zone"),
    afterTime: z.string().regex(hm, "HH:MM, 24-hour").optional(),
    beforeTime: z.string().regex(hm, "HH:MM, 24-hour").optional(),
  })
  .strict();
const proposeBookingArgs = z.object({ slotId: z.string().regex(/^A\d{1,2}$/, "slotId is like A1, from find_open_slots") }).strict();
const listArgs = z.object({}).strict();
const proposeCancelArgs = z.object({ booking: z.string().regex(/^B\d{1,2}$/, "booking is like B1, from list_my_bookings") }).strict();

export type AssistantScope = ProposalScope & {
  viewerTz: string;
  services: PromptService[];
  /** Service references -> ids, server-side. Only these services exist as far as the model is concerned. */
  serviceIds: Map<string, string>;
  now: Date;
};

export type AssistantTools = {
  tools: AnyToolDef[];
  /** Proposal ids created by this turn's handlers, in order. */
  created: () => string[];
};

const pad = (n: number) => String(n).padStart(2, "0");
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** `Tue 2026-11-17 15:00` in `timeZone`. */
export function formatLocal(date: Date, timeZone: string): string {
  const d = new TZDate(date.getTime(), timeZone);
  return `${WEEKDAYS[d.getDay()]} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A real calendar date, not just the right shape (no 2026-02-31). */
function parseDate(value: string): { y: number; m: number; d: number } {
  const [y, m, d] = value.split("-").map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) throw new ToolError(`${value} is not a real date.`);
  return { y, m, d };
}

const minutes = (value: string | undefined): number | null => (value ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null);

/** The model hears why a call failed, but only from messages this app wrote for clients. */
function asToolError(err: unknown): never {
  if (err instanceof ToolError) throw err;
  if (err instanceof HttpError && err.status < 500) throw new ToolError(err.message);
  throw err;
}

export function createAssistantTools(scope: AssistantScope): AssistantTools {
  assertCan(scope.actor, "create");
  let calls = 0;
  const created: string[] = [];
  // Replaced on every call: a reference from an earlier result stops working, so the model can only
  // propose what it was just shown, and nothing it invents resolves to anything.
  let slotRefs = new Map<string, { serviceId: string; startsAt: Date }>();
  let bookingRefs = new Map<string, string>();

  const budget = () => {
    if (++calls > MAX_TOOL_CALLS_PER_TURN) throw new ToolError("Tool call limit for this turn reached. Answer with what you have.");
  };

  const findOpenSlots = defineTool({
    name: "find_open_slots",
    description:
      "List open appointment times for one service between two dates (customer's time zone, at most 7 days, today or later). Optionally keep only starts from afterTime and/or before beforeTime (HH:MM). Returns up to 12 slots with slotIds for propose_booking.",
    args: findArgs,
    kind: "read",
    async run(args) {
      budget();
      const serviceId = scope.serviceIds.get(args.service);
      if (!serviceId) throw new ToolError(`Unknown service. Use one of: ${[...scope.serviceIds.keys()].join(", ") || "(none)"}.`);
      const from = parseDate(args.fromDate);
      const to = parseDate(args.toDate);
      const startMs = Date.UTC(from.y, from.m - 1, from.d);
      const endMs = Date.UTC(to.y, to.m - 1, to.d);
      if (endMs < startMs) throw new ToolError("toDate must not be before fromDate.");
      if ((endMs - startMs) / 86_400_000 + 1 > MAX_WINDOW_DAYS) throw new ToolError(`Ask for at most ${MAX_WINDOW_DAYS} days at a time.`);
      if (args.fromDate < todayInZone(scope.viewerTz, scope.now)) throw new ToolError("fromDate must be today or later.");
      const fromInstant = new Date(new TZDate(from.y, from.m - 1, from.d, 0, 0, 0, scope.viewerTz).getTime());
      const toInstant = new Date(new TZDate(to.y, to.m - 1, to.d + 1, 0, 0, 0, scope.viewerTz).getTime());

      const loaded = await loadAvailability(scope.providerId, serviceId, fromInstant, toInstant);
      if (!loaded) throw new ToolError("That service isn't available.");
      const after = minutes(args.afterTime);
      const before = minutes(args.beforeTime);
      // Filter by time of day BEFORE the engine's 200-slot cap bites: one call per local day, so an evening-only
      // search over 7 days still reaches the later evenings. Stops once one more than the result limit is found.
      const matching: { start: Date }[] = [];
      const days = Math.round((endMs - startMs) / 86_400_000) + 1;
      for (let i = 0; i < days && matching.length <= MAX_SLOTS_PER_RESULT; i++) {
        const dayFrom = new Date(new TZDate(from.y, from.m - 1, from.d + i, 0, 0, 0, scope.viewerTz).getTime());
        const dayTo = new Date(new TZDate(from.y, from.m - 1, from.d + i + 1, 0, 0, 0, scope.viewerTz).getTime());
        for (const slot of availableSlots({ ...loaded, from: dayFrom, to: dayTo, now: scope.now })) {
          const local = new TZDate(slot.start.getTime(), scope.viewerTz);
          const at = local.getHours() * 60 + local.getMinutes();
          if ((after === null || at >= after) && (before === null || at < before)) matching.push(slot);
        }
      }
      const shown = matching.slice(0, MAX_SLOTS_PER_RESULT);
      slotRefs = new Map(shown.map((slot, i) => [`A${i + 1}`, { serviceId, startsAt: slot.start }]));
      return {
        timeZone: scope.viewerTz,
        slots: shown.map((slot, i) => ({ slotId: `A${i + 1}`, startLocal: formatLocal(slot.start, scope.viewerTz), startUtc: slot.start.toISOString() })),
        more: matching.length > shown.length,
      };
    },
  });

  const proposeBooking = defineTool({
    name: "propose_booking",
    description:
      "Propose booking one of the slots from the latest find_open_slots result. Nothing is booked: the customer must tap Confirm. Returns the proposalId to put in your final answer.",
    args: proposeBookingArgs,
    kind: "propose",
    async run(args) {
      budget();
      const slot = slotRefs.get(args.slotId);
      if (!slot) throw new ToolError("Unknown slotId. Call find_open_slots first and use one of its slotIds.");
      try {
        const made = await createBookProposal(scope, slot, scope.now);
        created.push(made.id);
        return {
          proposalId: made.id,
          summary: `${sanitizeText(made.serviceName, 80)} on ${formatLocal(made.startsAt, scope.viewerTz)} (${scope.viewerTz}). Waiting for the customer to tap Confirm.`,
        };
      } catch (err) {
        return asToolError(err);
      }
    },
  });

  const listMyBookings = defineTool({
    name: "list_my_bookings",
    description: "List the signed-in customer's own upcoming bookings with this provider (never anyone else's), as B-references for propose_cancel.",
    args: listArgs,
    kind: "read",
    async run() {
      budget();
      const rows = await db()
        .select({ id: schema.booking.id, serviceName: schema.booking.serviceName, startsAt: schema.booking.startsAt })
        .from(schema.booking)
        .where(
          ownedBy(
            { ownerId: schema.booking.customerId },
            scope.actor,
            eq(schema.booking.providerId, scope.providerId),
            eq(schema.booking.status, "confirmed"),
            gt(schema.booking.startsAt, scope.now),
          ),
        )
        .orderBy(asc(schema.booking.startsAt))
        .limit(10);
      bookingRefs = new Map(rows.map((r, i) => [`B${i + 1}`, r.id]));
      return {
        timeZone: scope.viewerTz,
        bookings: rows.map((r, i) => ({ booking: `B${i + 1}`, service: sanitizeText(r.serviceName, 80), startLocal: formatLocal(r.startsAt, scope.viewerTz), startUtc: r.startsAt.toISOString() })),
      };
    },
  });

  const proposeCancel = defineTool({
    name: "propose_cancel",
    description:
      "Propose cancelling one of the customer's own bookings from the latest list_my_bookings result. Nothing is cancelled: the customer must tap Confirm. Returns the proposalId to put in your final answer.",
    args: proposeCancelArgs,
    kind: "propose",
    async run(args) {
      budget();
      const bookingId = bookingRefs.get(args.booking);
      if (!bookingId) throw new ToolError("Unknown booking. Call list_my_bookings first and use one of its references.");
      try {
        const made = await createCancelProposal(scope, bookingId, scope.now);
        created.push(made.id);
        return {
          proposalId: made.id,
          summary: `Cancel ${sanitizeText(made.serviceName, 80)} on ${formatLocal(made.startsAt, scope.viewerTz)} (${scope.viewerTz}). Waiting for the customer to tap Confirm.`,
        };
      } catch (err) {
        return asToolError(err);
      }
    },
  });

  return { tools: [findOpenSlots, proposeBooking, listMyBookings, proposeCancel], created: () => [...created] };
}

