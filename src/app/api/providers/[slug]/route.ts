import { z } from "zod";
import { getPublicProvider } from "@/lib/provider";
import { errorResponse } from "@/lib/http";
import { NotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** GET /api/providers/:slug — public profile and active services. No owner id and no email. */
export async function GET(_request: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await ctx.params;
    const parsed = z.string().regex(/^[a-z0-9-]{3,40}$/).safeParse(slug);
    if (!parsed.success) throw new NotFoundError();
    const provider = await getPublicProvider(parsed.data);
    if (!provider) throw new NotFoundError();
    return Response.json({ provider });
  } catch (err) {
    return errorResponse(err);
  }
}
