import { requireUser } from "@/lib/auth/session";
import { createBooking, listBookings } from "@/lib/bookings";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/bookings?as=customer|provider&when=upcoming|past|all&limit= — the caller's own bookings. */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const params = Object.fromEntries(new URL(request.url).searchParams);
    return Response.json({ bookings: await listBookings(user, params) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/bookings — `{ serviceId, startsAt, note? }`. 409 when the time isn't free (with fresh `slots`). */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const booking = await createBooking(user, await readJson(request));
    return Response.json({ booking }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
