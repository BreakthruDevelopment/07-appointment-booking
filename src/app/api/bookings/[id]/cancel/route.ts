import { requireUser } from "@/lib/auth/session";
import { cancelBooking } from "@/lib/bookings";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** POST /api/bookings/:id/cancel — idempotent; the customer until the notice cutoff, the provider until it starts. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const { id } = await ctx.params;
    return Response.json({ booking: await cancelBooking(user, id) });
  } catch (err) {
    return errorResponse(err);
  }
}
