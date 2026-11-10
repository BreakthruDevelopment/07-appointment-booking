import { dismissProposal, parseProposalId } from "@/lib/assistant/proposals";
import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** POST /api/proposals/:id/dismiss — "Not now": closes the caller's own open card. Idempotent; 404 for anyone else's. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const { id } = await ctx.params;
    return Response.json(await dismissProposal(user, parseProposalId(id)));
  } catch (err) {
    return errorResponse(err);
  }
}
