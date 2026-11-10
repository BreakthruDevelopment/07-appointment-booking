import "server-only";
import { TZDate } from "@date-fns/tz";
import { and, eq, inArray } from "drizzle-orm";
import { type Actor, ForbiddenError } from "@/lib/auth/rbac";
import { availableSlots, loadAvailability } from "@/lib/availability";
import { insertBookingRow } from "@/lib/bookings";
import { db, schema } from "@/lib/db";
import { DEMO_EMAIL_DOMAIN, MARKER } from "@/lib/demo-identity";
import { ConflictError, TooManyRequestsError } from "@/lib/errors";
import { log } from "@/lib/log";
import { reserveDaily } from "@/lib/usage";

/**
 * The demo workspace: one provider, "Demo Studio" (America/Denver), three services, two customers and
 * bookings around the nearest daylight-saving change, so the calendar, the feed and the DST rules all have
 * something real to show. Demo users are marked with MARKER in `user.image` and have no password, so nobody
 * can sign in as them; reloading replaces only rows carrying that marker and refuses to touch a real account
 * that happens to use a demo id, email or slug.
 */

export const DEMO_LOADS_PER_DAY = 10;
export const DEMO_SLUG = "demo-studio";
export const DEMO_TIME_ZONE = "America/Denver";

const PROVIDER_ID = "demo-studio-provider";
const CUSTOMERS = [
  { id: "demo-customer-1", name: "Avery Demo", email: `avery@${DEMO_EMAIL_DOMAIN}` },
  { id: "demo-customer-2", name: "Blake Demo", email: `blake@${DEMO_EMAIL_DOMAIN}` },
] as const;
const DEMO_USER_IDS = [PROVIDER_ID, ...CUSTOMERS.map((c) => c.id)];
const DEMO_EMAILS = [`studio@${DEMO_EMAIL_DOMAIN}`, ...CUSTOMERS.map((c) => c.email)];

const SERVICES = [
  { name: "Haircut", description: "Wash, cut and finish.", durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 5 },
  { name: "Color and style", description: "Single-process color with a blow-dry.", durationMin: 90, bufferBeforeMin: 0, bufferAfterMin: 15 },
  { name: "Consultation", description: "Talk through a new look.", durationMin: 60, bufferBeforeMin: 5, bufferAfterMin: 5 },
] as const;

/** Mon-Fri 09:00-12:00 and 13:00-18:00, Saturday 10:00-14:00, closed Sunday. */
const HOURS = [
  ...[1, 2, 3, 4, 5].flatMap((weekday) => [
    { weekday, startMin: 9 * 60, endMin: 12 * 60 },
    { weekday, startMin: 13 * 60, endMin: 18 * 60 },
  ]),
  { weekday: 6, startMin: 10 * 60, endMin: 14 * 60 },
];

export type DemoResult = { slug: string; services: number; customers: number; bookings: number; dstDate: string };

export async function loadDemoWorkspace(actor: Actor, now = new Date()): Promise<DemoResult> {
  if (actor.role !== "admin") throw new ForbiddenError();
  const dst = nearestTransition(DEMO_TIME_ZONE, now);

  const result = await db().transaction(async (tx) => {
    if (!(await reserveDaily(tx, "demo_load", DEMO_LOADS_PER_DAY))) {
      throw new TooManyRequestsError("The demo was loaded too many times today. Try again tomorrow.");
    }

    // Refuse to overwrite a real account that shares a demo id or email.
    const clashing = await tx
      .select({ id: schema.user.id, image: schema.user.image })
      .from(schema.user)
      .where(inArray(schema.user.id, DEMO_USER_IDS));
    const clashingEmail = await tx
      .select({ id: schema.user.id, image: schema.user.image })
      .from(schema.user)
      .where(inArray(schema.user.email, DEMO_EMAILS));
    if ([...clashing, ...clashingEmail].some((row) => row.image !== MARKER)) {
      throw new ConflictError("A real account uses a demo id or email, so the demo wasn't loaded.");
    }
    const [slugOwner] = await tx
      .select({ userId: schema.providerProfile.userId })
      .from(schema.providerProfile)
      .where(eq(schema.providerProfile.slug, DEMO_SLUG));
    if (slugOwner && !DEMO_USER_IDS.includes(slugOwner.userId)) {
      throw new ConflictError("Another provider uses the demo link, so the demo wasn't loaded.");
    }

    // Cascades remove the profile, services, hours, bookings and feed.
    await tx.delete(schema.user).where(and(inArray(schema.user.id, DEMO_USER_IDS), eq(schema.user.image, MARKER)));
    await tx.insert(schema.user).values([
      { id: PROVIDER_ID, name: "Demo Studio", email: `studio@${DEMO_EMAIL_DOMAIN}`, emailVerified: true, image: MARKER },
      ...CUSTOMERS.map((c) => ({ id: c.id, name: c.name, email: c.email, emailVerified: true, image: MARKER })),
    ]);
    await tx.insert(schema.providerProfile).values({
      userId: PROVIDER_ID,
      slug: DEMO_SLUG,
      displayName: "Demo Studio",
      bio: "A demo salon. Every booking here is sample data.",
      timeZone: DEMO_TIME_ZONE,
      accepting: true,
      minNoticeMinutes: 60,
      horizonDays: 60,
    });
    const services = await tx
      .insert(schema.service)
      .values(SERVICES.map((s, position) => ({ providerId: PROVIDER_ID, position, ...s })))
      .returning({ id: schema.service.id, name: schema.service.name, durationMin: schema.service.durationMin });
    await tx.insert(schema.weeklyHours).values(HOURS.map((h) => ({ providerId: PROVIDER_ID, ...h })));

    const byName = new Map<string, (typeof SERVICES)[number] & { id: string }>(SERVICES.map((s, i) => [s.name, { ...s, id: services[i].id }]));
    const around: { day: number; hour: number; minute: number; service: string; customer: 0 | 1; cancelled?: boolean }[] = [
      { day: -3, hour: 10, minute: 0, service: "Haircut", customer: 0 },
      { day: -2, hour: 14, minute: 0, service: "Consultation", customer: 1 },
      { day: -1, hour: 10, minute: 30, service: "Color and style", customer: 0 },
      { day: 1, hour: 9, minute: 30, service: "Haircut", customer: 1 },
      { day: 2, hour: 15, minute: 0, service: "Haircut", customer: 0, cancelled: true },
      { day: 3, hour: 16, minute: 0, service: "Consultation", customer: 1 },
    ];
    let bookings = 0;
    for (const spec of around) {
      const service = byName.get(spec.service)!;
      const start = new TZDate(dst.year, dst.month, dst.day + spec.day, spec.hour, spec.minute, 0, DEMO_TIME_ZONE);
      const startsAt = new Date(start.getTime());
      await insertBookingRow(tx, {
        providerId: PROVIDER_ID,
        customerId: CUSTOMERS[spec.customer].id,
        serviceId: service.id,
        serviceName: service.name,
        startsAt,
        durationMin: service.durationMin,
        bufferBeforeMin: service.bufferBeforeMin,
        bufferAfterMin: service.bufferAfterMin,
        providerTz: DEMO_TIME_ZONE,
        note: null,
        cancelled: spec.cancelled ? { by: "customer", at: new Date(Math.min(now.getTime(), startsAt.getTime() - 86_400_000)) } : undefined,
        createdAt: new Date(Math.min(now.getTime(), startsAt.getTime() - 2 * 86_400_000)),
      });
      bookings++;
    }

    // One genuinely upcoming booking, chosen by the real availability engine, so "My bookings" isn't empty.
    const haircut = byName.get("Haircut")!;
    const from = new Date(now.getTime() + 2 * 86_400_000);
    const to = new Date(from.getTime() + 7 * 86_400_000);
    const loaded = await loadAvailability(PROVIDER_ID, haircut.id, from, to, tx);
    const first = loaded ? availableSlots({ ...loaded, from, to, now })[0] : undefined;
    if (first) {
      await insertBookingRow(tx, {
        providerId: PROVIDER_ID,
        customerId: CUSTOMERS[1].id,
        serviceId: haircut.id,
        serviceName: haircut.name,
        startsAt: first.start,
        durationMin: haircut.durationMin,
        bufferBeforeMin: haircut.bufferBeforeMin,
        bufferAfterMin: haircut.bufferAfterMin,
        providerTz: DEMO_TIME_ZONE,
        createdAt: now,
      });
      bookings++;
    }
    return { slug: DEMO_SLUG, services: services.length, customers: CUSTOMERS.length, bookings, dstDate: dst.date };
  });
  log.info("demo.loaded", { bookings: result.bookings });
  return result;
}

/** The local calendar date of the daylight-saving change nearest to `now` (before or after). */
export function nearestTransition(timeZone: string, now: Date): { year: number; month: number; day: number; date: string } {
  const offsetAt = (ms: number) => new TZDate(ms, timeZone).getTimezoneOffset();
  let best: { ms: number; distance: number } | undefined;
  for (let d = -200; d <= 200; d++) {
    const ms = now.getTime() + d * 86_400_000;
    if (offsetAt(ms) !== offsetAt(ms + 86_400_000)) {
      const distance = Math.abs(d);
      if (!best || distance < best.distance) best = { ms: ms + 86_400_000, distance };
    }
  }
  // A zone without daylight saving: use today.
  const at = new TZDate(best?.ms ?? now.getTime(), timeZone);
  const date = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  return { year: at.getFullYear(), month: at.getMonth(), day: at.getDate(), date };
}
