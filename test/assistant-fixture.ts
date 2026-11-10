/**
 * Shared set-up for the assistant's tests: a provider with a service menu, customers, and a scripted model.
 * The scripted model replaces only the network call (`provider.step`); the tool loop, the real tool handlers
 * and the database are all the real thing.
 */
import type postgres from "postgres";
import { vi } from "vitest";
import type { AiProvider, ToolCall, ToolHistoryItem, ToolStepRequest, ToolStepResult } from "@/lib/ai/types";
import type { Actor } from "@/lib/auth/rbac";
import { resetEnvCache } from "@/lib/env";

/** Monday 2026-06-01 06:00 in Denver. Tuesday is 2026-06-02; Sunday is 2026-06-07. */
export const NOW = new Date("2026-06-01T12:00:00Z");
export const TZ = "America/Denver";

type Holder = { provider?: AiProvider };
const holder = (): Holder => ((globalThis as unknown as { __bookingStub?: Holder }).__bookingStub ??= {});

/** Used by the `vi.mock` of the providers module: the scripted model when one is installed, else the real one. */
export const currentStub = (): AiProvider | undefined => holder().provider;

export type Script = (req: ToolStepRequest, n: number) => ToolStepResult;

export function installScript(script: Script): { requests: ToolStepRequest[] } {
  const requests: ToolStepRequest[] = [];
  holder().provider = {
    name: "stub",
    model: "stub-1",
    complete: () => Promise.reject(new Error("complete() must not be used by the assistant")),
    step: async (req) => {
      requests.push({ ...req, history: structuredClone(req.history), deadlineAt: 0 });
      return script(req, requests.length);
    },
  };
  return { requests };
}
export const clearScript = () => {
  holder().provider = undefined;
};

let ids = 0;
export const call = (name: string, args: unknown): ToolCall => ({ id: `c${++ids}`, name, args });
export const respond = (args: unknown): ToolCall => call("respond", args);
export const turn = (...calls: ToolCall[]): ToolStepResult => ({ calls, text: "", raw: { parts: calls } });

/** The newest tool result for `tool` in what the model has been told so far. */
export function lastResult(history: ToolHistoryItem[], tool: string): Record<string, unknown> | undefined {
  for (const item of [...history].reverse()) {
    if (item.role !== "tool_results") continue;
    const hit = [...item.results].reverse().find((r) => r.name === tool);
    if (hit) return hit.output;
  }
  return undefined;
}
export const proposalIdOf = (history: ToolHistoryItem[], tool = "propose_booking"): string | null =>
  ((lastResult(history, tool) as { data?: { proposalId?: string } } | undefined)?.data?.proposalId ?? null);
export const allToolOutput = (history: ToolHistoryItem[]): string =>
  JSON.stringify(history.filter((h) => h.role === "tool_results"));

/** AI settings for a test. The model is "gemini" (scripted) unless `demo`. */
export function setAi(mode: "scripted" | "demo", extra: Record<string, string> = {}) {
  vi.stubEnv("AI_PROVIDER", mode === "demo" ? "demo" : "gemini");
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  vi.stubEnv("AI_FALLBACK_TO_DEMO", "false");
  vi.stubEnv("LOG_LEVEL", "error");
  vi.stubEnv("CHAT_DAILY_CAP", "");
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
  resetEnvCache();
}

export type World = {
  prov: Actor;
  prov2: Actor;
  ann: Actor;
  bob: Actor;
  admin: Actor;
  slug: string;
  slug2: string;
  haircutId: string;
  colorId: string;
  otherServiceId: string;
};

/**
 * Provider P (America/Denver; Mon-Sat 09:00-18:00, Sunday closed; services Haircut 30 min = S1, Color 60 min = S2),
 * a second provider P2, customers Ann and Bob and an admin. All ids start with `prefix`.
 */
export async function seedWorld(sql: postgres.Sql, prefix: string): Promise<World> {
  const prov: Actor = { id: `${prefix}-prov`, role: "user" };
  const prov2: Actor = { id: `${prefix}-prov2`, role: "user" };
  const ann: Actor = { id: `${prefix}-ann`, role: "user" };
  const bob: Actor = { id: `${prefix}-bob`, role: "user" };
  const admin: Actor = { id: `${prefix}-admin`, role: "admin" };
  await sql`delete from "user" where id like ${prefix + "-%"}`;
  for (const u of [prov, prov2, ann, bob, admin]) {
    await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@test.local"}, ${u.role})`;
  }
  const { replaceHours, saveService, upsertProfile } = await import("@/lib/provider");
  const slug = `${prefix}-studio`;
  const slug2 = `${prefix}-other`;
  const profile = (s: string) => ({ slug: s, displayName: `Studio ${s}`, bio: "", timeZone: TZ, accepting: true, minNoticeMinutes: 0, horizonDays: 30 });
  await upsertProfile(prov, profile(slug));
  await upsertProfile(prov2, profile(slug2));
  const week = { hours: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 18 * 60 })) };
  await replaceHours(prov, week);
  await replaceHours(prov2, week);
  const haircutId = (await saveService(prov, { name: "Haircut", durationMin: 30, position: 0 })).id;
  const colorId = (await saveService(prov, { name: "Color", durationMin: 60, position: 1 })).id;
  const otherServiceId = (await saveService(prov2, { name: "Haircut", durationMin: 30 })).id;
  return { prov, prov2, ann, bob, admin, slug, slug2, haircutId, colorId, otherServiceId };
}

export async function wipeWorld(sql: postgres.Sql, prefix: string) {
  const like = `${prefix}-%`;
  await sql`delete from chat_thread where customer_id like ${like}`;
  await sql`delete from booking where provider_id like ${like} or customer_id like ${like}`;
  await sql`delete from rate_event where user_id like ${like}`;
  await sql`delete from daily_usage where kind = 'chat_step'`;
}
