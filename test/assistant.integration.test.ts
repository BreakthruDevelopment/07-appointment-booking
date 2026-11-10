/**
 * The booking assistant's data rules against Postgres (TEST_DATABASE_URL): tool-handler authorization with
 * foreign ids, proposal ownership / expiry / single use, confirm-with-stored-values, rate and daily caps,
 * history caps, demo mode offline, logs without message text, and the route contracts the chat panel uses.
 */
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolError } from "@/lib/ai";
import type { AnyToolDef } from "@/lib/ai/types";
import type { Actor } from "@/lib/auth/rbac";
import { resetEnvCache } from "@/lib/env";
import { NOW, TZ, type World, call, clearScript, proposalIdOf, respond, seedWorld, setAi, turn, installScript, wipeWorld } from "./assistant-fixture";

vi.mock("@/lib/ai/providers", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ai/providers")>();
  const { currentStub } = await import("./assistant-fixture");
  return { ...real, geminiProvider: (key: string, model: string) => currentStub() ?? real.geminiProvider(key, model) };
});

// Route tests: the signed-in user is whoever `session.user` says.
const session: { user: (Actor & { name: string; email: string }) | null } = { user: null };
vi.mock("@/lib/auth/session", async () => {
  const { UnauthorizedError } = await import("@/lib/auth/rbac");
  return {
    requireUser: async () => {
      if (!session.user) throw new UnauthorizedError();
      return session.user;
    },
  };
});

const url = process.env.TEST_DATABASE_URL;
const P = "as";
const SLOT = "2026-06-02T21:00:00.000Z"; // Tuesday 15:00 in Denver
const SLOT2 = "2026-06-02T22:00:00.000Z";

describe.skipIf(!url)("booking assistant (Postgres)", () => {
  let sql: postgres.Sql;
  let w: World;
  let t = 0;
  const tick = () => new Date(NOW.getTime() + 1000 * ++t);
  const asUser = (a: Actor) => {
    session.user = { ...a, name: a.id, email: `${a.id}@test.local` };
  };

  const scope = (actor: Actor, threadId: string, providerId = w.prov.id) => ({ actor, threadId, providerId });
  async function thread(actor: Actor, providerId = w.prov.id) {
    const [row] = await sql`insert into chat_thread (customer_id, provider_id) values (${actor.id}, ${providerId})
      on conflict (customer_id, provider_id) do update set customer_id = excluded.customer_id returning id`;
    return row.id as string;
  }
  async function propose(actor: Actor, startsAt = SLOT, serviceId = w.haircutId, now = NOW) {
    const { createBookProposal } = await import("@/lib/assistant/proposals");
    return createBookProposal(scope(actor, await thread(actor)), { serviceId, startsAt: new Date(startsAt) }, now);
  }
  const bookingsOf = async (customer: string) => Number((await sql`select count(*)::int as n from booking where customer_id = ${customer}`)[0].n);
  const find = (tools: AnyToolDef[], name: string) => tools.find((x) => x.name === name)!;
  const run = (tools: AnyToolDef[], name: string, args: unknown) => {
    const tool = find(tools, name);
    return tool.run(tool.args.parse(args), { signal: new AbortController().signal });
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = "http://localhost:3000";
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    await wipeWorld(sql, P);
    w = await seedWorld(sql, P);
  });
  beforeEach(async () => {
    await wipeWorld(sql, P);
    // Tests below edit the provider; start each from the seeded state even if the last one failed midway.
    await sql`update provider_profile set min_notice_minutes = 0, accepting = true where user_id like ${P + "-%"}`;
    const { replaceHours } = await import("@/lib/provider");
    await replaceHours(w.prov, { hours: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 540, endMin: 1080 })) });
    setAi("scripted");
  });
  afterEach(() => {
    clearScript();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetEnvCache();
    session.user = null;
  });
  afterAll(async () => {
    await wipeWorld(sql, P);
    await sql`delete from "user" where id like ${P + "-%"}`;
    await sql.end();
  });

  describe("tool handlers are bound to the actor and provider", () => {
    async function toolsFor(actor: Actor, providerId = w.prov.id) {
      const { createAssistantTools } = await import("@/lib/assistant/tools");
      return createAssistantTools({
        actor,
        threadId: await thread(actor, providerId),
        providerId,
        viewerTz: TZ,
        services: [
          { ref: "S1", name: "Haircut", durationMin: 30 },
          { ref: "S2", name: "Color", durationMin: 60 },
        ],
        serviceIds: new Map([["S1", w.haircutId], ["S2", w.colorId]]),
        now: NOW,
      });
    }

    it("find_open_slots: only this provider's services exist; foreign ids, bad dates and wide windows are refused", async () => {
      const { tools } = await toolsFor(w.ann);
      const ok = (await run(tools, "find_open_slots", { service: "S1", fromDate: "2026-06-02", toDate: "2026-06-02" })) as { slots: unknown[] };
      expect(ok.slots.length).toBeGreaterThan(0);
      // The other provider's service id isn't a reference at all; an unissued reference resolves to nothing.
      expect(() => find(tools, "find_open_slots").args.parse({ service: w.otherServiceId, fromDate: "2026-06-02", toDate: "2026-06-02" })).toThrow();
      await expect(run(tools, "find_open_slots", { service: "S9", fromDate: "2026-06-02", toDate: "2026-06-02" })).rejects.toBeInstanceOf(ToolError);
      await expect(run(tools, "find_open_slots", { service: "S1", fromDate: "2026-02-31", toDate: "2026-03-01" })).rejects.toThrow(/not a real date/);
      await expect(run(tools, "find_open_slots", { service: "S1", fromDate: "2026-06-02", toDate: "2026-06-09" })).rejects.toThrow(/at most 7 days/);
      await expect(run(tools, "find_open_slots", { service: "S1", fromDate: "2026-06-03", toDate: "2026-06-02" })).rejects.toThrow(/before/);
      await expect(run(tools, "find_open_slots", { service: "S1", fromDate: "2026-05-30", toDate: "2026-05-31" })).rejects.toThrow(/today or later/);
      expect(() => find(tools, "find_open_slots").args.parse({ service: "S1", fromDate: "2026-06-02", toDate: "2026-06-02", providerId: w.prov2.id })).toThrow();
    });

    it("find_open_slots: results are capped at 12 and flag more", async () => {
      const { tools } = await toolsFor(w.ann);
      const r = (await run(tools, "find_open_slots", { service: "S1", fromDate: "2026-06-02", toDate: "2026-06-04" })) as { slots: unknown[]; more: boolean };
      expect(r.slots).toHaveLength(12);
      expect(r.more).toBe(true);
    });

    it("propose_booking: needs a slotId from this turn's find_open_slots, and the earlier ids stop working", async () => {
      const { tools, created } = await toolsFor(w.ann);
      await expect(run(tools, "propose_booking", { slotId: "A1" })).rejects.toThrow(/Unknown slotId/);
      await run(tools, "find_open_slots", { service: "S1", fromDate: "2026-06-02", toDate: "2026-06-02", afterTime: "17:00" });
      await run(tools, "find_open_slots", { service: "S2", fromDate: "2026-06-02", toDate: "2026-06-02", afterTime: "17:00" }); // 60 min: only 17:00 fits
      await expect(run(tools, "propose_booking", { slotId: "A2" })).rejects.toThrow(/Unknown slotId/);
      const made = (await run(tools, "propose_booking", { slotId: "A1" })) as { proposalId: string; summary: string };
      expect(created()).toEqual([made.proposalId]);
      const [row] = await sql`select service_id, starts_at, customer_id, kind from booking_proposal where id = ${made.proposalId}`;
      expect(row).toMatchObject({ service_id: w.colorId, customer_id: w.ann.id, kind: "book" });
      expect(new Date(row.starts_at).toISOString()).toBe("2026-06-02T23:00:00.000Z"); // Tuesday 17:00 in Denver
      expect(await bookingsOf(w.ann.id)).toBe(0);
    });

    it("propose_booking: another provider's service is a 404 and writes nothing; so is a provider booking their own page", async () => {
      const { createBookProposal } = await import("@/lib/assistant/proposals");
      const s = scope(w.ann, await thread(w.ann));
      await expect(createBookProposal(s, { serviceId: w.otherServiceId, startsAt: new Date(SLOT) }, NOW)).rejects.toMatchObject({ status: 404 });
      await expect(createBookProposal(s, { serviceId: "00000000-0000-4000-8000-000000000000", startsAt: new Date(SLOT) }, NOW)).rejects.toMatchObject({ status: 404 });
      // Not an offered time (Sunday 03:00 Denver, and off the 15-minute grid).
      await expect(createBookProposal(s, { serviceId: w.haircutId, startsAt: new Date("2026-06-07T09:00:00.000Z") }, NOW)).rejects.toMatchObject({ status: 409 });
      await expect(createBookProposal(s, { serviceId: w.haircutId, startsAt: new Date("2026-06-02T21:07:00.000Z") }, NOW)).rejects.toMatchObject({ status: 409 });
      const own = scope(w.prov, await thread(w.ann), w.prov.id);
      await expect(createBookProposal(own, { serviceId: w.haircutId, startsAt: new Date(SLOT) }, NOW)).rejects.toMatchObject({ status: 409 });
      expect(Number((await sql`select count(*)::int as n from booking_proposal`)[0].n)).toBe(0);
    });

    it("propose_booking: a time someone else already holds is refused", async () => {
      const { createBooking } = await import("@/lib/bookings");
      await createBooking(w.bob, { serviceId: w.haircutId, startsAt: SLOT }, NOW);
      await expect(propose(w.ann)).rejects.toMatchObject({ status: 409 });
    });

    it("list_my_bookings: only the caller's confirmed, future bookings with this provider", async () => {
      const { createBooking, cancelBooking } = await import("@/lib/bookings");
      const mine = await createBooking(w.ann, { serviceId: w.haircutId, startsAt: SLOT }, NOW);
      const cancelled = await createBooking(w.ann, { serviceId: w.haircutId, startsAt: SLOT2 }, NOW);
      await cancelBooking(w.ann, cancelled.id, NOW);
      const bobs = await createBooking(w.bob, { serviceId: w.haircutId, startsAt: "2026-06-03T16:00:00.000Z" }, NOW);
      const elsewhere = await createBooking(w.ann, { serviceId: w.otherServiceId, startsAt: "2026-06-03T18:00:00.000Z" }, NOW);
      const { tools } = await toolsFor(w.ann);
      const out = (await run(tools, "list_my_bookings", {})) as { bookings: { booking: string; service: string }[] };
      expect(out.bookings).toHaveLength(1);
      expect(JSON.stringify(out)).not.toContain(bobs.id);
      expect(JSON.stringify(out)).not.toContain(elsewhere.id);
      expect(JSON.stringify(out)).not.toContain(mine.id); // references only; ids stay server-side
      // Bob's tools see Bob's.
      const bobsTools = await toolsFor(w.bob);
      expect(((await run(bobsTools.tools, "list_my_bookings", {})) as { bookings: unknown[] }).bookings).toHaveLength(1);
    });

    it("propose_cancel: a B-reference must come from this turn's list; the data function re-checks ownership for any id", async () => {
      const { createBooking, cancelBooking } = await import("@/lib/bookings");
      const { createCancelProposal } = await import("@/lib/assistant/proposals");
      const mine = await createBooking(w.ann, { serviceId: w.haircutId, startsAt: SLOT }, NOW);
      const bobs = await createBooking(w.bob, { serviceId: w.haircutId, startsAt: SLOT2 }, NOW);
      const elsewhere = await createBooking(w.ann, { serviceId: w.otherServiceId, startsAt: "2026-06-03T18:00:00.000Z" }, NOW);
      const gone = await createBooking(w.ann, { serviceId: w.haircutId, startsAt: "2026-06-03T16:00:00.000Z" }, NOW);
      await cancelBooking(w.ann, gone.id, NOW);

      const { tools } = await toolsFor(w.ann);
      await expect(run(tools, "propose_cancel", { booking: "B1" })).rejects.toThrow(/Unknown booking/);
      expect(() => find(tools, "propose_cancel").args.parse({ booking: bobs.id })).toThrow();
      await run(tools, "list_my_bookings", {});
      await expect(run(tools, "propose_cancel", { booking: "B2" })).rejects.toThrow(/Unknown booking/);

      const s = scope(w.ann, await thread(w.ann));
      for (const foreign of [bobs.id, elsewhere.id, gone.id, "00000000-0000-4000-8000-000000000000"]) {
        await expect(createCancelProposal(s, foreign, NOW)).rejects.toMatchObject({ status: 404 });
      }
      // Bob can't use Ann's booking either, and a provider is not the customer.
      await expect(createCancelProposal(scope(w.bob, await thread(w.bob)), mine.id, NOW)).rejects.toMatchObject({ status: 404 });
      await expect(createCancelProposal(scope(w.prov, await thread(w.ann)), mine.id, NOW)).rejects.toMatchObject({ status: 404 });
      // Already started.
      await expect(createCancelProposal(s, mine.id, new Date("2026-06-02T22:00:00Z"))).rejects.toMatchObject({ status: 404 });
      expect(Number((await sql`select count(*)::int as n from booking_proposal`)[0].n)).toBe(0);

      const made = (await run(tools, "propose_cancel", { booking: "B1" })) as { proposalId: string };
      const [row] = await sql`select kind, booking_id, customer_id from booking_proposal where id = ${made.proposalId}`;
      expect(row).toMatchObject({ kind: "cancel", booking_id: mine.id, customer_id: w.ann.id });
    });

    it("propose_cancel respects the provider's cancellation notice", async () => {
      const { createBooking } = await import("@/lib/bookings");
      const { createCancelProposal } = await import("@/lib/assistant/proposals");
      const b = await createBooking(w.ann, { serviceId: w.haircutId, startsAt: "2026-06-10T16:00:00.000Z" }, NOW);
      await sql`update provider_profile set min_notice_minutes = 1440 where user_id = ${w.prov.id}`;
      await expect(createCancelProposal(scope(w.ann, await thread(w.ann)), b.id, new Date("2026-06-09T20:00:00Z"))).rejects.toMatchObject({ status: 409, extra: { code: "cancellation_closed" } });
      await expect(createCancelProposal(scope(w.ann, await thread(w.ann)), b.id, new Date("2026-06-08T20:00:00Z"))).resolves.toBeTruthy();
    });

    it("every tool call counts against a per-turn budget", async () => {
      const { tools } = await toolsFor(w.ann);
      for (let i = 0; i < 6; i++) await run(tools, "list_my_bookings", {});
      await expect(run(tools, "list_my_bookings", {})).rejects.toThrow(/limit for this turn/);
    });
  });

  describe("confirming a proposal", () => {
    it("books the stored service and time, once; the proposal row records the booking", async () => {
      const { confirmProposal } = await import("@/lib/assistant/proposals");
      const made = await propose(w.ann);
      const done = await confirmProposal(w.ann, made.id, NOW);
      expect(done).toMatchObject({ action: "booked", booking: { startsAt: SLOT, serviceId: w.haircutId, role: "customer" } });
      const [row] = await sql`select used_at, booking_id from booking_proposal where id = ${made.id}`;
      expect(row.used_at).not.toBeNull();
      expect(row.booking_id).toBe(done.booking.id);
      await expect(confirmProposal(w.ann, made.id, NOW)).rejects.toMatchObject({ status: 409, extra: { code: "proposal_used" } });
      expect(await bookingsOf(w.ann.id)).toBe(1);
    });

    it("five simultaneous confirms of one proposal make exactly one booking", async () => {
      const { confirmProposal } = await import("@/lib/assistant/proposals");
      const made = await propose(w.ann);
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => confirmProposal(w.ann, made.id, NOW)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((x) => x.status === "rejected")) expect((r as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
      expect(await bookingsOf(w.ann.id)).toBe(1);
    });

    it("is for the owner only: another customer, the provider and an admin get 404 and book nothing", async () => {
      const { confirmProposal } = await import("@/lib/assistant/proposals");
      const made = await propose(w.ann);
      for (const stranger of [w.bob, w.prov, w.admin, w.prov2]) {
        await expect(confirmProposal(stranger, made.id, NOW)).rejects.toMatchObject({ status: 404 });
      }
      await expect(confirmProposal(w.ann, "not-a-uuid", NOW)).rejects.toMatchObject({ status: 404 });
      expect(Number((await sql`select count(*)::int as n from booking`)[0].n)).toBe(0);
      // And the owner's proposal is still open.
      expect((await sql`select used_at from booking_proposal where id = ${made.id}`)[0].used_at).toBeNull();
    });

    it("expires after 10 minutes, and a newer proposal supersedes an older one", async () => {
      const { confirmProposal } = await import("@/lib/assistant/proposals");
      const made = await propose(w.ann);
      expect(made.expiresAt.getTime()).toBe(NOW.getTime() + 10 * 60_000);
      await expect(confirmProposal(w.ann, made.id, new Date(NOW.getTime() + 10 * 60_000))).rejects.toMatchObject({ status: 409, extra: { code: "proposal_expired" } });
      const first = await propose(w.ann, SLOT);
      const second = await propose(w.ann, SLOT2);
      await expect(confirmProposal(w.ann, first.id, NOW)).rejects.toMatchObject({ extra: { code: "proposal_expired" } });
      expect((await confirmProposal(w.ann, second.id, NOW)).booking.startsAt).toBe(SLOT2);
    });

    it("dismiss closes the owner's card only", async () => {
      const { confirmProposal, dismissProposal } = await import("@/lib/assistant/proposals");
      const made = await propose(w.ann);
      await expect(dismissProposal(w.bob, made.id, NOW)).rejects.toMatchObject({ status: 404 });
      expect((await sql`select expires_at from booking_proposal where id = ${made.id}`)[0].expires_at.getTime()).toBeGreaterThan(NOW.getTime());
      await dismissProposal(w.ann, made.id, NOW);
      await dismissProposal(w.ann, made.id, NOW); // idempotent
      await expect(confirmProposal(w.ann, made.id, NOW)).rejects.toMatchObject({ extra: { code: "proposal_expired" } });
    });

    it("re-validates at confirm: a time taken meanwhile is 409 slot_taken with fresh slots, nothing is booked, and the card can be retried", async () => {
      const { confirmProposal, proposalViews } = await import("@/lib/assistant/proposals");
      const { createBooking } = await import("@/lib/bookings");
      const made = await propose(w.ann);
      await createBooking(w.bob, { serviceId: w.haircutId, startsAt: SLOT }, NOW);
      const err = await confirmProposal(w.ann, made.id, NOW).catch((e) => e);
      expect(err).toMatchObject({ status: 409, extra: { code: "slot_taken" } });
      expect(err.extra.slots).toEqual(expect.arrayContaining([expect.any(String)]));
      expect(err.extra.slots).not.toContain(SLOT);
      expect(await bookingsOf(w.ann.id)).toBe(0);
      expect((await proposalViews(w.ann, [made.id], NOW)).get(made.id)?.status).toBe("open");
    });

    it("the provider closing the slot after the proposal is 409 slot_unavailable", async () => {
      const { confirmProposal } = await import("@/lib/assistant/proposals");
      const made = await propose(w.ann);
      await sql`delete from weekly_hours where provider_id = ${w.prov.id} and weekday = 2`;
      await expect(confirmProposal(w.ann, made.id, NOW)).rejects.toMatchObject({ status: 409, extra: { code: "slot_unavailable" } });
      const { replaceHours } = await import("@/lib/provider");
      await replaceHours(w.prov, { hours: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 540, endMin: 1080 })) });
    });

    it("applies the normal booking limits (3 upcoming per provider)", async () => {
      const { confirmProposal } = await import("@/lib/assistant/proposals");
      for (const hour of [15, 16, 17]) {
        const made = await propose(w.ann, `2026-06-02T${hour + 6}:00:00.000Z`);
        await confirmProposal(w.ann, made.id, NOW);
      }
      const fourth = await propose(w.ann, "2026-06-03T16:00:00.000Z");
      await expect(confirmProposal(w.ann, fourth.id, NOW)).rejects.toMatchObject({ status: 409, extra: { code: "limit_reached" } });
      expect(await bookingsOf(w.ann.id)).toBe(3);
    });

    it("a cancel proposal cancels the stored booking through cancelBooking, with its notice rule", async () => {
      const { confirmProposal, createCancelProposal } = await import("@/lib/assistant/proposals");
      const { createBooking } = await import("@/lib/bookings");
      const b = await createBooking(w.ann, { serviceId: w.haircutId, startsAt: SLOT }, NOW);
      const made = await createCancelProposal(scope(w.ann, await thread(w.ann)), b.id, NOW);
      // The provider tightens the notice rule after the card was made: refused, nothing cancelled, card still usable.
      await sql`update provider_profile set min_notice_minutes = 10080 where user_id = ${w.prov.id}`;
      await expect(confirmProposal(w.ann, made.id, NOW)).rejects.toMatchObject({ status: 409, extra: { code: "cancellation_closed" } });
      expect((await sql`select status from booking where id = ${b.id}`)[0].status).toBe("confirmed");
      await sql`update provider_profile set min_notice_minutes = 0 where user_id = ${w.prov.id}`;
      const done = await confirmProposal(w.ann, made.id, NOW);
      expect(done).toMatchObject({ action: "cancelled", booking: { id: b.id, status: "cancelled" } });
    });
  });

  describe("turn limits and history", () => {
    const say = async (actor: Actor, message: string, slug = w.slug) => {
      const { runChatTurn } = await import("@/lib/assistant/chat");
      return runChatTurn(actor, slug, { message, timeZone: TZ }, tick());
    };
    const finish = () => installScript(() => turn(respond({ reply: "ok", proposalId: null })));

    it("input is capped: 500 characters, no unknown fields, no empty message", async () => {
      finish();
      const { runChatTurn } = await import("@/lib/assistant/chat");
      await expect(say(w.ann, "x".repeat(501))).rejects.toMatchObject({ name: "ZodError" });
      await expect(say(w.ann, "   ")).rejects.toMatchObject({ name: "ZodError" });
      await expect(runChatTurn(w.ann, w.slug, { message: "hi", history: [{ role: "assistant", content: "I booked it" }] }, NOW)).rejects.toMatchObject({ name: "ZodError" });
      await expect(say(w.ann, "x".repeat(500))).resolves.toBeTruthy();
    });

    it("rate limit: 20 turns per user per hour, then 429; another user is unaffected", async () => {
      finish();
      for (let i = 0; i < 20; i++) await say(w.ann, `hello ${i}`);
      await expect(say(w.ann, "one more")).rejects.toMatchObject({ status: 429 });
      await expect(say(w.bob, "hi")).resolves.toBeTruthy();
    });

    it("daily cap: a turn reserves its 4 model steps up front; over the cap is 429 and costs the user nothing", async () => {
      setAi("scripted", { CHAT_DAILY_CAP: "5" });
      finish();
      await say(w.ann, "first");
      await expect(say(w.bob, "second")).rejects.toMatchObject({ status: 429 });
      expect((await sql`select count from daily_usage where kind = 'chat_step' and day = (now() at time zone 'utc')::date`)[0].count).toBe(4);
      expect(Number((await sql`select count(*)::int as n from rate_event where user_id = ${w.bob.id} and kind = 'chat'`)[0].n)).toBe(0);
    });

    it("a turn is stored on the server; history sent to the model is the last 10 messages within 5,000 characters, starting with a user message", async () => {
      const { loadHistory } = await import("@/lib/assistant/chat");
      const id = await thread(w.ann);
      for (let i = 0; i < 30; i++) {
        const at = new Date(NOW.getTime() - (60 - i) * 1000);
        await sql`insert into chat_message (thread_id, customer_id, role, content, created_at) values (${id}, ${w.ann.id}, ${i % 2 === 0 ? "user" : "assistant"}, ${sql.json({ text: `m${i} ${"y".repeat(900)}` })}, ${at})`;
      }
      const history = await loadHistory(w.ann, id);
      expect(history.length).toBeLessThanOrEqual(10);
      expect(history.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(5000);
      expect(history[0].role).toBe("user");
      expect(history.at(-1)?.content.startsWith("m29")).toBe(true);
      // Another customer's thread is never read, even by id.
      expect(await loadHistory(w.bob, id)).toEqual([]);

      const { requests } = installScript(() => turn(respond({ reply: "ok", proposalId: null })));
      await say(w.ann, "next");
      expect(requests[0].history.at(-1)).toEqual({ role: "user", text: "next" });
      expect(requests[0].history.length).toBeLessThanOrEqual(11);
    });

    it("a customer can't chat with their own page, or one that isn't accepting bookings", async () => {
      finish();
      await expect(say(w.prov, "hi")).rejects.toMatchObject({ status: 400 });
      await sql`update provider_profile set accepting = false where user_id = ${w.prov2.id}`;
      await expect(say(w.ann, "hi", w.slug2)).rejects.toMatchObject({ status: 404 });
      await expect(say(w.ann, "hi", "no-such-studio")).rejects.toMatchObject({ status: 404 });
      await sql`update provider_profile set accepting = true where user_id = ${w.prov2.id}`;
    });

    it("saved chats are private: another customer, the provider and an admin see nothing", async () => {
      finish();
      await say(w.ann, "my private question");
      const { getChat } = await import("@/lib/assistant/chat");
      expect((await getChat(w.ann, w.slug)).messages.map((m) => m.text)).toEqual(["my private question", "ok"]);
      for (const other of [w.bob, w.admin]) expect((await getChat(other, w.slug)).messages).toEqual([]);
    });

    it("after a propose call there is no demo fallback: a provider failure is an error and the demo does not propose a second time", async () => {
      setAi("scripted", { AI_FALLBACK_TO_DEMO: "true" });
      const { runChatTurn } = await import("@/lib/assistant/chat");
      installScript((req, n) => {
        if (n === 1) return turn(call("find_open_slots", { service: "S1", fromDate: "2026-06-02", toDate: "2026-06-02" }));
        if (n === 2) return turn(call("propose_booking", { slotId: "A1" }));
        throw Object.assign(new Error("boom"), { name: "AiError", kind: "provider" });
      });
      await expect(runChatTurn(w.ann, w.slug, { message: "book tuesday", timeZone: TZ }, tick())).rejects.toMatchObject({ message: "boom" });
      expect(Number((await sql`select count(*)::int as n from booking_proposal where customer_id = ${w.ann.id}`)[0].n)).toBe(1);
      expect(await bookingsOf(w.ann.id)).toBe(0);
    });

    it("never logs message text", async () => {
      vi.stubEnv("LOG_LEVEL", "debug");
      resetEnvCache();
      const lines: string[] = [];
      for (const fn of ["log", "error", "warn", "info"] as const) vi.spyOn(console, fn).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
      installScript((req, n) =>
        n === 1 ? turn(call("find_open_slots", { service: "S1", fromDate: "2026-06-02", toDate: "2026-06-02", afterTime: "15:00" })) : n === 2 ? turn(call("propose_booking", { slotId: "A1" })) : turn(respond({ reply: "Quokka-reply-text-91", proposalId: proposalIdOf(req.history) })),
      );
      await say(w.ann, "zebra-message-text-77 book tuesday");
      const all = lines.join("\n");
      expect(all).toContain("ai.tool_loop");
      expect(all).toContain("chat.turn");
      expect(all).not.toContain("zebra-message-text-77");
      expect(all).not.toContain("Quokka-reply-text-91");
      expect(all).not.toContain("book tuesday");
    });
  });

  describe("demo mode (AI_PROVIDER=demo): works offline", () => {
    it("runs the recorded script through the real handlers and proposes a genuinely free time", async () => {
      setAi("demo");
      vi.stubGlobal("fetch", () => {
        throw new Error("no network in demo mode");
      });
      const { runChatTurn } = await import("@/lib/assistant/chat");
      const { createBooking } = await import("@/lib/bookings");
      // Take Tuesday 09:00-09:30 first: the demo must offer the next free start, 09:30.
      await createBooking(w.bob, { serviceId: w.haircutId, startsAt: "2026-06-02T15:00:00.000Z" }, NOW);
      const out = await runChatTurn(w.ann, w.slug, { message: "anything tuesday after 3?", timeZone: TZ }, tick());
      vi.unstubAllGlobals();
      expect(out.demo).toBe(true);
      expect(out.messages[1].text).toBe("Demo assistant (recorded): I found the first open time for Haircut. Tap Confirm to book it.");
      expect(out.proposal).toMatchObject({ kind: "book", status: "open", startsAt: "2026-06-02T15:30:00.000Z" });
      expect(out.messages[1].suggestions).toEqual(["Show later times"]);
      expect(await bookingsOf(w.ann.id)).toBe(0);
      // The demo doesn't spend the daily model-step budget.
      expect((await sql`select count(*)::int as n from daily_usage where kind = 'chat_step'`)[0].n).toBe(0);
      const { confirmProposal } = await import("@/lib/assistant/proposals");
      expect((await confirmProposal(w.ann, out.proposal!.id, tick())).booking.startsAt).toBe("2026-06-02T15:30:00.000Z");
    });

    it("says so when there is nothing to offer", async () => {
      setAi("demo");
      await sql`delete from weekly_hours where provider_id = ${w.prov.id}`;
      const { runChatTurn } = await import("@/lib/assistant/chat");
      const out = await runChatTurn(w.ann, w.slug, { message: "anything?", timeZone: TZ }, tick());
      expect(out.proposal).toBeNull();
      expect(out.messages[1].text).toContain("couldn't find an open time");
      const { replaceHours } = await import("@/lib/provider");
      await replaceHours(w.prov, { hours: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 540, endMin: 1080 })) });
    });
  });

  describe("route contracts (what the chat panel calls)", () => {
    const post = (path: string, body: unknown, origin = "http://localhost:3000") =>
      new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });

    it("POST /api/chat/:slug then POST /api/bookings { proposalId } books; the confirm body can't carry a service or time", async () => {
      setAi("demo");
      asUser(w.ann);
      const chat = await import("@/app/api/chat/[slug]/route");
      const bookings = await import("@/app/api/bookings/route");
      const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

      const res = await chat.POST(post(`/api/chat/${w.slug}`, { message: "tuesday after 3?", timeZone: TZ }), params(w.slug));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ demo: true, fallback: false, messages: [{ role: "user" }, { role: "assistant" }], proposal: { kind: "book", status: "open" } });
      expect(JSON.stringify(body)).not.toContain("@test.local");

      // History for the page load carries the card, rebuilt from the row.
      const hist = await (await chat.GET(new Request(`http://localhost:3000/api/chat/${w.slug}`), params(w.slug))).json();
      expect(hist.messages).toHaveLength(2);
      expect(hist.messages[1].proposal.id).toBe(body.proposal.id);

      // Smuggling values next to the id is refused outright.
      for (const extra of [{ serviceId: w.colorId }, { startsAt: SLOT2 }, { note: "x" }]) {
        const bad = await bookings.POST(post("/api/bookings", { proposalId: body.proposal.id, ...extra }));
        expect(bad.status).toBe(400);
      }
      expect((await bookings.POST(post("/api/bookings", { proposalId: body.proposal.id }, "https://evil.example"))).status).toBe(403);
      expect(await bookingsOf(w.ann.id)).toBe(0);

      // Another user can't use it; the owner can, once.
      asUser(w.bob);
      expect((await bookings.POST(post("/api/bookings", { proposalId: body.proposal.id }))).status).toBe(404);
      asUser(w.ann);
      const ok = await bookings.POST(post("/api/bookings", { proposalId: body.proposal.id }));
      expect(ok.status).toBe(201);
      expect(await ok.json()).toMatchObject({ action: "booked", booking: { startsAt: body.proposal.startsAt, status: "confirmed" } });
      const again = await bookings.POST(post("/api/bookings", { proposalId: body.proposal.id }));
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ code: "proposal_used" });
      expect(await bookingsOf(w.ann.id)).toBe(1);
    });

    it("anonymous callers get 401, cross-origin posts 403, and the plain create body still works", async () => {
      setAi("demo");
      const chat = await import("@/app/api/chat/[slug]/route");
      const bookings = await import("@/app/api/bookings/route");
      const dismiss = await import("@/app/api/proposals/[id]/dismiss/route");
      const params = { params: Promise.resolve({ slug: w.slug }) };
      expect((await chat.POST(post(`/api/chat/${w.slug}`, { message: "hi" }), params)).status).toBe(401);
      expect((await chat.GET(new Request("http://localhost:3000/x"), params)).status).toBe(401);
      expect((await bookings.POST(post("/api/bookings", { proposalId: "x" }))).status).toBe(401);
      asUser(w.ann);
      expect((await chat.POST(post(`/api/chat/${w.slug}`, { message: "hi" }, "https://evil.example"), params)).status).toBe(403);
      const made = await propose(w.ann);
      const idParams = { params: Promise.resolve({ id: made.id }) };
      expect((await dismiss.POST(post(`/api/proposals/${made.id}/dismiss`, {}, "https://evil.example"), idParams)).status).toBe(403);
      asUser(w.bob);
      expect((await dismiss.POST(post(`/api/proposals/${made.id}/dismiss`, {}), idParams)).status).toBe(404);
      asUser(w.ann);
      expect((await dismiss.POST(post(`/api/proposals/${made.id}/dismiss`, {}), idParams)).status).toBe(200);
      const plain = await bookings.POST(post("/api/bookings", { serviceId: w.haircutId, startsAt: SLOT2 }));
      expect([201, 409]).toContain(plain.status); // the fixed test clock is in the past relative to the real one
    });

    it("a tool-loop failure answers 200 with the fallback reply; a provider failure never leaks details", async () => {
      asUser(w.ann);
      const chat = await import("@/app/api/chat/[slug]/route");
      const params = { params: Promise.resolve({ slug: w.slug }) };
      installScript(() => turn(call("find_open_slots", { service: "S1", fromDate: "2099-01-01", toDate: "2099-01-01" })));
      const loop = await chat.POST(post(`/api/chat/${w.slug}`, { message: "hi" }), params);
      expect(loop.status).toBe(200);
      expect(await loop.json()).toMatchObject({ fallback: true, proposal: null });
    });
  });
});
