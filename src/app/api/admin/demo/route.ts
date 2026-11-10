import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { loadDemoWorkspace } from "@/lib/demo";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** POST /api/admin/demo — (re)create the Demo Studio workspace. Admin only; capped per day. */
export async function POST(request: Request) {
  try {
    const user = await requireRole("admin");
    requireSameOrigin(request);
    return Response.json(await loadDemoWorkspace(user), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
