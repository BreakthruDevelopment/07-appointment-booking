import { requireUser } from "@/lib/auth/session";
import { getBookingIcs } from "@/lib/bookings";
import { errorResponse } from "@/lib/http";
import { icsHeaders } from "@/lib/ics";

export const dynamic = "force-dynamic";

/** GET /api/bookings/:id/ics — one event, for the customer or the provider only. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const { filename, body } = await getBookingIcs(user, id);
    return new Response(body, { headers: icsHeaders({ "content-disposition": `attachment; filename="${filename}"` }) });
  } catch (err) {
    return errorResponse(err);
  }
}
