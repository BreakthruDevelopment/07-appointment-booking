import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { getFeedStatus, rotateFeedToken } from "@/lib/feed";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/provider/feed — whether a calendar link exists. The URL itself is only shown when it is made. */
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json(await getFeedStatus(user));
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/provider/feed — create or rotate the private calendar URL; returned once, the old one stops working. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const feed = await rotateFeedToken(user);
    return Response.json(feed, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
