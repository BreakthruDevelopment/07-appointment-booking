import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { getOwnProfile, upsertProfile } from "@/lib/provider";

export const dynamic = "force-dynamic";

/** GET /api/provider/profile — the caller's provider profile. */
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ profile: await getOwnProfile(user) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PUT /api/provider/profile — create or replace the caller's provider profile. */
export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const profile = await upsertProfile(user, await readJson(request));
    return Response.json({ profile });
  } catch (err) {
    return errorResponse(err);
  }
}
