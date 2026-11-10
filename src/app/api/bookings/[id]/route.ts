import { requireUser } from "@/lib/auth/session";
import { getBooking } from "@/lib/bookings";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/bookings/:id — the customer or the provider of that booking; anyone else gets 404. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    return Response.json({ booking: await getBooking(user, id) });
  } catch (err) {
    return errorResponse(err);
  }
}
