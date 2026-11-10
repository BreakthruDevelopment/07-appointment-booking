import type { DemoToolScript } from "./types";

/**
 * Recorded answers keyed by task name. Demo mode keeps live demos working when the
 * free model quota is used up, and lets tests run without a network or API key.
 * Each app adds a fixture for each AI task it defines.
 */
export const demoFixtures: Record<string, unknown> = {
  "summarize-items": {
    summary:
      "You have a few open items. The most recent ones focus on setup work; nothing looks overdue.",
    highlights: ["Setup tasks are the largest group", "No items are flagged urgent"],
  },
};

/**
 * Scripted tool loops for tasks that use `generate({ tools })`, keyed by task name. A script is a function
 * of the caller's `demoContext`; the loop runs the real handlers for each step, then `final` builds the
 * answer from their results. Keep `args` valid for the real tool schemas.
 */
export const demoToolScripts: Record<string, (ctx: unknown) => DemoToolScript> = {
  // Example for the README: an assistant that looks items up, then answers.
  "items-assistant": (ctx) => {
    const query = typeof (ctx as { query?: unknown } | undefined)?.query === "string" ? (ctx as { query: string }).query : "setup";
    return {
      steps: [{ call: { name: "search_items", args: { query } } }],
      final: (results) => {
        const found = results[0]?.ok && Array.isArray(results[0].data) ? results[0].data.length : 0;
        return { reply: `Demo assistant (recorded): I found ${found} matching item${found === 1 ? "" : "s"}.`, matches: found };
      },
    };
  },

  // The booking assistant (src/lib/assistant). The script calls the REAL tool handlers, so a demo proposes a
  // genuinely free time; it never books (only the customer's tap on the confirm card does). Offline, no key.
  "booking-assistant": (ctx) => {
    const { today, serviceName } = demoBookingContext(ctx);
    const from = addDays(today, 1);
    const to = addDays(today, 6);
    return {
      steps: [
        { call: { name: "find_open_slots", args: { service: "S1", fromDate: from, toDate: to } } },
        { call: { name: "propose_booking", args: { slotId: "A1" } } },
      ],
      final: (results) => {
        const proposal = results[1];
        const proposalId =
          proposal?.ok && typeof (proposal.data as { proposalId?: unknown })?.proposalId === "string"
            ? (proposal.data as { proposalId: string }).proposalId
            : null;
        if (!proposalId) {
          return {
            reply: `Demo assistant (recorded): I couldn't find an open time for ${serviceName} this week. Try the times on the page.`,
            proposalId: null,
            suggestions: [],
          };
        }
        return {
          reply: `Demo assistant (recorded): I found the first open time for ${serviceName}. Tap Confirm to book it.`,
          proposalId,
          suggestions: ["Show later times"],
        };
      },
    };
  },
};

function demoBookingContext(ctx: unknown): { today: string; serviceName: string } {
  const c = (ctx ?? {}) as { today?: unknown; serviceName?: unknown };
  const today = typeof c.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c.today) ? c.today : new Date().toISOString().slice(0, 10);
  const serviceName = typeof c.serviceName === "string" && c.serviceName ? c.serviceName.slice(0, 80) : "that service";
  return { today, serviceName };
}

/** `YYYY-MM-DD` plus whole days, in calendar terms (no zone: the string is already a local date). */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function demoAnswer(task: string): string {
  const fixture = demoFixtures[task];
  if (fixture === undefined) {
    throw new Error(`No demo fixture for AI task "${task}". Add one to src/lib/ai/demo.ts.`);
  }
  return JSON.stringify(fixture);
}
