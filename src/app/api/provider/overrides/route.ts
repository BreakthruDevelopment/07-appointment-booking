import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { listOverrides, replaceOverrides } from "@/lib/provider";

export const dynamic = "force-dynamic";

/** GET /api/provider/overrides — the caller's date overrides. */
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ overrides: await listOverrides(user) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PUT /api/provider/overrides — replace the caller's date overrides. */
export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    return Response.json({ overrides: await replaceOverrides(user, await readJson(request)) });
  } catch (err) {
    return errorResponse(err);
  }
}
