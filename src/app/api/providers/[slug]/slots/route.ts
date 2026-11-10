import { z } from "zod";
import { availableSlots, loadAvailabilityBySlug, parseSlotWindow } from "@/lib/availability";
import { NotFoundError } from "@/lib/errors";
import { errorResponse } from "@/lib/http";
import { assertSlotRate, clientIp } from "@/lib/slot-rate";

export const dynamic = "force-dynamic";

/** GET /api/providers/:slug/slots?serviceId=&from=&to= — open starts as UTC ISO strings. */
export async function GET(request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    assertSlotRate(clientIp(request));
    const { slug } = await ctx.params;
    const parsedSlug = z.string().regex(/^[a-z0-9-]{3,40}$/).safeParse(slug);
    if (!parsedSlug.success) throw new NotFoundError();
    const url = new URL(request.url);
    const serviceId = z.uuid().parse(url.searchParams.get("serviceId"));
    const { from, to } = parseSlotWindow(url.searchParams.get("from"), url.searchParams.get("to"));
    const loaded = await loadAvailabilityBySlug(parsedSlug.data, serviceId, from, to);
    if (!loaded) throw new NotFoundError();
    const slots = availableSlots({ ...loaded, from, to, now: new Date() }).map((slot) => slot.start.toISOString());
    return Response.json({ timeZone: loaded.profile.timeZone, slots });
  } catch (err) {
    return errorResponse(err);
  }
}
