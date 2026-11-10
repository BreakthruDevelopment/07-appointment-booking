import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { listHours, replaceHours } from "@/lib/provider";

export const dynamic = "force-dynamic";

/** GET /api/provider/hours — the caller's weekly opening hours. */
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ hours: await listHours(user) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PUT /api/provider/hours — replace the caller's weekly hours. An id they don't own is 404. */
export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    return Response.json({ hours: await replaceHours(user, await readJson(request)) });
  } catch (err) {
    return errorResponse(err);
  }
}
