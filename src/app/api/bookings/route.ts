import { z } from "zod";
import { confirmProposal } from "@/lib/assistant/proposals";
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

// Confirming takes the proposal id and nothing else: the service and time come from the stored proposal.
const confirmInput = z.object({ proposalId: z.string().max(64) }).strict();

/**
 * POST /api/bookings — `{ serviceId, startsAt, note? }`, or `{ proposalId }` to confirm the assistant's card.
 * 409 when the time isn't free (with fresh `slots`). A proposal confirm answers `{ action, booking }`:
 * 201 "booked" for a booking proposal, 200 "cancelled" for a cancel proposal; 404 if it isn't the caller's,
 * 409 `proposal_used` / `proposal_expired`.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const body = await readJson(request);
    if (body && typeof body === "object" && "proposalId" in body) {
      const { proposalId } = confirmInput.parse(body);
      const done = await confirmProposal(user, proposalId);
      return Response.json(done, { status: done.action === "booked" ? 201 : 200 });
    }
    const booking = await createBooking(user, body);
    return Response.json({ booking }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
