import { getChat, runChatTurn } from "@/lib/assistant/chat";
import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/chat/:slug — the caller's saved conversation with this provider (newest 50), cards rebuilt from proposal rows. */
export async function GET(_request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const user = await requireUser();
    const { slug } = await ctx.params;
    return Response.json(await getChat(user, slug));
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/chat/:slug — `{ message (1-500 chars), timeZone? }` runs one assistant turn.
 * 200 `{ messages: [user, assistant], proposal | null, demo, fallback }`. 429 when over the hourly or daily limit.
 * The proposal is a card to render, never something already done: only `POST /api/bookings { proposalId }` books.
 */
export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const { slug } = await ctx.params;
    return Response.json(await runChatTurn(user, slug, await readJson(request)));
  } catch (err) {
    return errorResponse(err);
  }
}
