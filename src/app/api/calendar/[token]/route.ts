import { errorResponse } from "@/lib/http";
import { NotFoundError } from "@/lib/errors";
import { renderFeed } from "@/lib/feed";
import { icsHeaders } from "@/lib/ics";
import { assertFeedRate, clientIp } from "@/lib/slot-rate";

export const dynamic = "force-dynamic";

/**
 * GET /api/calendar/:token.ics — the provider's private feed. The token in the path is the credential
 * (`[token]` receives it with its `.ics` suffix). Anything that doesn't match is the same 404.
 */
export async function GET(request: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    assertFeedRate(clientIp(request));
    const { token } = await ctx.params;
    const body = await renderFeed(token);
    if (body === null) throw new NotFoundError();
    return new Response(body, { headers: icsHeaders({ "content-disposition": 'inline; filename="bookings.ics"' }) });
  } catch (err) {
    return errorResponse(err);
  }
}
