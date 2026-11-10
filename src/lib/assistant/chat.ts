import "server-only";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { AiError, generate } from "@/lib/ai";
import type { ChatMessage } from "@/lib/ai/types";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { todayInZone } from "@/lib/availability";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { BadRequestError, NotFoundError, TooManyRequestsError } from "@/lib/errors";
import { log } from "@/lib/log";
import { consumeRate, releaseDaily, reserveDaily } from "@/lib/usage";
import { MAX_SERVICE_REFS, buildSystemPrompt, sanitizeText } from "./prompt";
import { type ProposalView, proposalViews } from "./proposals";
import { createAssistantTools } from "./tools";

/**
 * One assistant turn: the customer's message in, the assistant's reply (and at most one confirm card) out.
 * History lives on the server, so a client can't forge past turns or tool results. The model's only effects
 * are `booking_proposal` rows; the customer's tap on the card is what books.
 */

export const TASK = "booking-assistant";
export const MAX_MESSAGE_CHARS = 500;
export const HISTORY_MESSAGES = 10;
export const HISTORY_CHARS = 5000;
export const TURNS_PER_HOUR = 20;
/** Model steps one turn can use (generate's `maxSteps`); reserved against the daily cap before the call. */
export const STEPS_PER_TURN = 4;
export const TURN_DEADLINE_MS = 24_000;
export const FALLBACK_REPLY = "I couldn't finish that; here are the open times on the page.";
const PAGE_MESSAGES = 50;

const turnInput = z
  .object({
    message: z.string().trim().min(1, "Type a message.").max(MAX_MESSAGE_CHARS),
    /** The browser's IANA zone. Only affects how times are shown and how the model's dates are read. */
    timeZone: z.string().max(64).optional(),
  })
  .strict();

/** The model's final answer. `proposalId` is checked against this turn's proposals before it reaches anyone. */
export const answerSchema = z.object({
  reply: z.string().min(1).max(600),
  proposalId: z.string().uuid().nullable().catch(null),
  suggestions: z.array(z.string().max(40)).max(3).catch([]),
});

export type ChatMessageView = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  suggestions: string[];
  /** Present on an assistant message that came with a confirm card; built from the proposal row. */
  proposal: ProposalView | null;
};

export type TurnResult = {
  messages: ChatMessageView[];
  /** The card to show now, or null. Same object as on the assistant message. */
  proposal: ProposalView | null;
  /** True when the reply came from the recorded demo script, not a live model. */
  demo: boolean;
  /** True when the model couldn't finish and the canned reply was used. */
  fallback: boolean;
};

function validZone(zone: string | undefined): string | null {
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

type Provider = { id: string; slug: string; displayName: string; timeZone: string; services: { id: string; name: string; durationMin: number }[] };

async function loadProvider(actor: Actor, slug: unknown): Promise<Provider> {
  const parsed = z.string().regex(/^[a-z0-9-]{3,40}$/).safeParse(slug);
  if (!parsed.success) throw new NotFoundError();
  const [profile] = await db()
    .select({ id: schema.providerProfile.userId, slug: schema.providerProfile.slug, displayName: schema.providerProfile.displayName, timeZone: schema.providerProfile.timeZone, accepting: schema.providerProfile.accepting })
    .from(schema.providerProfile)
    .where(eq(schema.providerProfile.slug, parsed.data));
  // Not accepting bookings is not public, so it isn't found.
  if (!profile || !profile.accepting) throw new NotFoundError();
  if (profile.id === actor.id) throw new BadRequestError("You can't chat with your own booking page.");
  const services = await db()
    .select({ id: schema.service.id, name: schema.service.name, durationMin: schema.service.durationMin })
    .from(schema.service)
    .where(and(eq(schema.service.providerId, profile.id), eq(schema.service.active, true)))
    .orderBy(asc(schema.service.position), asc(schema.service.name), asc(schema.service.id))
    .limit(MAX_SERVICE_REFS);
  return { id: profile.id, slug: profile.slug, displayName: profile.displayName, timeZone: profile.timeZone, services };
}

async function getOrCreateThread(actor: Actor, providerId: string): Promise<string> {
  await db().insert(schema.chatThread).values({ customerId: actor.id, providerId }).onConflictDoNothing();
  const [thread] = await db()
    .select({ id: schema.chatThread.id })
    .from(schema.chatThread)
    .where(and(eq(schema.chatThread.customerId, actor.id), eq(schema.chatThread.providerId, providerId)));
  if (!thread) throw new NotFoundError();
  return thread.id;
}

type StoredContent = { text?: unknown; suggestions?: unknown; proposalId?: unknown };

function textOf(content: StoredContent): string {
  return typeof content.text === "string" ? content.text : "";
}

/** Last 10 messages, at most 5,000 characters, oldest dropped first; always starts with a user message. */
export async function loadHistory(actor: Actor, threadId: string): Promise<ChatMessage[]> {
  const rows = await db()
    .select({ role: schema.chatMessage.role, content: schema.chatMessage.content })
    .from(schema.chatMessage)
    .where(and(eq(schema.chatMessage.threadId, threadId), eq(schema.chatMessage.customerId, actor.id)))
    .orderBy(desc(schema.chatMessage.createdAt), desc(schema.chatMessage.id))
    .limit(HISTORY_MESSAGES);
  const messages: ChatMessage[] = rows
    .reverse()
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({ role: r.role as "user" | "assistant", content: textOf(r.content) }))
    .filter((m) => m.content.length > 0);
  let total = messages.reduce((n, m) => n + m.content.length, 0);
  while (messages.length > 0 && (total > HISTORY_CHARS || messages[0].role !== "user")) {
    total -= messages.shift()!.content.length;
  }
  return messages;
}

/** Reserve this turn's budget: per-user turns per hour, then the app-wide daily step cap, in one short transaction. */
async function reserveTurn(actor: Actor): Promise<{ steps: number }> {
  const live = env().AI_PROVIDER !== "demo";
  const cap = env().CHAT_DAILY_CAP;
  await db().transaction(async (tx) => {
    await consumeRate(tx, actor.id, "chat", TURNS_PER_HOUR, `You can send ${TURNS_PER_HOUR} assistant messages per hour. Try again later or use the times on the page.`);
    if (live) {
      for (let i = 0; i < STEPS_PER_TURN; i++) {
        // Throwing rolls the whole transaction back, the hourly count included: a refused turn costs nothing.
        if (!(await reserveDaily(tx, "chat_step", cap))) {
          throw new TooManyRequestsError("The assistant has reached its limit for today. Use the times on the page.");
        }
      }
    }
  });
  return { steps: live ? STEPS_PER_TURN : 0 };
}

export async function runChatTurn(actor: Actor, slug: unknown, input: unknown, now = new Date()): Promise<TurnResult> {
  assertCan(actor, "create");
  const { message, timeZone } = turnInput.parse(input);
  const provider = await loadProvider(actor, slug);
  const viewerTz = validZone(timeZone) ?? provider.timeZone;
  const threadId = await getOrCreateThread(actor, provider.id);
  const reserved = await reserveTurn(actor);
  const started = Date.now();

  const services = provider.services.map((s, i) => ({ ref: `S${i + 1}`, name: s.name, durationMin: s.durationMin }));
  const today = todayInZone(viewerTz, now);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: viewerTz }).format(now);
  const system = buildSystemPrompt({ providerName: provider.displayName, providerTz: provider.timeZone, viewerTz, today, weekday, services });
  const history = await loadHistory(actor, threadId);
  const tools = createAssistantTools({
    actor,
    threadId,
    providerId: provider.id,
    viewerTz,
    services,
    serviceIds: new Map(provider.services.map((s, i) => [`S${i + 1}`, s.id])),
    now,
  });

  let reply: string;
  let proposalId: string | null = null;
  let suggestions: string[] = [];
  let demo = false;
  let fallback = false;
  try {
    const result = await generate({
      task: TASK,
      system,
      messages: [...history, { role: "user", content: message }],
      schema: answerSchema,
      tools: tools.tools,
      maxSteps: STEPS_PER_TURN,
      deadlineMs: TURN_DEADLINE_MS,
      maxOutputTokens: 600,
      demoContext: { today, serviceName: services[0]?.name },
    });
    demo = result.demo;
    reply = result.data.reply;
    suggestions = result.data.suggestions.map((s) => sanitizeText(s, 40)).filter(Boolean);
    // Only a proposal this turn's handlers created for this actor counts; if the model forgot to name it, the
    // latest one is used. Either way the card is rendered from the row, not from anything the model wrote.
    const mine = tools.created();
    proposalId = result.data.proposalId && mine.includes(result.data.proposalId) ? result.data.proposalId : (mine.at(-1) ?? null);
    if (demo && reserved.steps > 0) await releaseSteps(reserved.steps);
  } catch (err) {
    if (err instanceof AiError && err.kind === "tool_loop") {
      reply = FALLBACK_REPLY;
      fallback = true;
    } else {
      // A turn that never reached the model shouldn't spend the day's model steps.
      if (reserved.steps > 0 && err instanceof AiError && err.kind === "input_rejected") await releaseSteps(reserved.steps);
      throw err;
    }
  }

  // The user's message and the reply are stored together, only once the turn succeeded.
  const userAt = new Date(now.getTime());
  const assistantAt = new Date(now.getTime() + 1);
  const stored = await db().transaction(async (tx) => {
    const [u] = await tx
      .insert(schema.chatMessage)
      .values({ threadId, customerId: actor.id, role: "user", content: { text: message }, createdAt: userAt })
      .returning({ id: schema.chatMessage.id });
    const [a] = await tx
      .insert(schema.chatMessage)
      .values({ threadId, customerId: actor.id, role: "assistant", content: { text: reply, suggestions, ...(proposalId ? { proposalId } : {}) }, createdAt: assistantAt })
      .returning({ id: schema.chatMessage.id });
    return { userId: u.id, assistantId: a.id };
  });
  const views = await proposalViews(actor, proposalId ? [proposalId] : [], now);
  const proposal = proposalId ? (views.get(proposalId) ?? null) : null;

  log.info("chat.turn", { providerId: provider.id, outcome: fallback ? "fallback" : "ok", demo, proposed: tools.created().length, hasProposal: proposal !== null, latencyMs: Date.now() - started });
  return {
    messages: [
      { id: stored.userId, role: "user", text: message, createdAt: userAt.toISOString(), suggestions: [], proposal: null },
      { id: stored.assistantId, role: "assistant", text: reply, createdAt: assistantAt.toISOString(), suggestions, proposal },
    ],
    proposal,
    demo,
    fallback,
  };
}

async function releaseSteps(steps: number): Promise<void> {
  await db().transaction(async (tx) => {
    for (let i = 0; i < steps; i++) await releaseDaily(tx, "chat_step");
  });
}

/** The customer's saved conversation with this provider (newest 50), cards rebuilt from the proposal rows. */
export async function getChat(actor: Actor, slug: unknown, now = new Date()): Promise<{ messages: ChatMessageView[] }> {
  assertCan(actor, "create");
  const provider = await loadProvider(actor, slug);
  const [thread] = await db()
    .select({ id: schema.chatThread.id })
    .from(schema.chatThread)
    .where(and(eq(schema.chatThread.customerId, actor.id), eq(schema.chatThread.providerId, provider.id)));
  if (!thread) return { messages: [] };
  const rows = await db()
    .select({ id: schema.chatMessage.id, role: schema.chatMessage.role, content: schema.chatMessage.content, createdAt: schema.chatMessage.createdAt })
    .from(schema.chatMessage)
    .where(and(eq(schema.chatMessage.threadId, thread.id), eq(schema.chatMessage.customerId, actor.id)))
    .orderBy(desc(schema.chatMessage.createdAt), desc(schema.chatMessage.id))
    .limit(PAGE_MESSAGES);
  rows.reverse();
  const ids = rows.flatMap((r) => (typeof (r.content as StoredContent).proposalId === "string" ? [(r.content as StoredContent).proposalId as string] : []));
  const views = await proposalViews(actor, ids, now);
  return {
    messages: rows
      .filter((r) => r.role === "user" || r.role === "assistant")
      .map((r) => {
        const c = r.content as StoredContent;
        const pid = typeof c.proposalId === "string" ? c.proposalId : null;
        return {
          id: r.id,
          role: r.role as "user" | "assistant",
          text: textOf(c),
          createdAt: r.createdAt.toISOString(),
          suggestions: Array.isArray(c.suggestions) ? c.suggestions.filter((s): s is string => typeof s === "string").slice(0, 3) : [],
          proposal: pid ? (views.get(pid) ?? null) : null,
        };
      }),
  };
}

