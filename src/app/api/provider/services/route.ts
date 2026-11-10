import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { deleteService, listServices, saveService } from "@/lib/provider";

export const dynamic = "force-dynamic";

/** GET /api/provider/services — the caller's services. */
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ services: await listServices(user) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PUT /api/provider/services — create a service, or update one when `id` is the caller's. */
export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const service = await saveService(user, await readJson(request));
    return Response.json({ service }, { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/provider/services — body `{ id }`. Someone else's id is 404. */
export async function DELETE(request: Request) {
  try {
    const user = await requireUser();
    requireSameOrigin(request);
    const body = (await readJson(request)) as { id?: unknown };
    await deleteService(user, body && typeof body === "object" ? body.id : undefined);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
