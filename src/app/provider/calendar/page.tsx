import type { Metadata } from "next";
import Link from "next/link";
import { BookingCard } from "@/components/booking/booking-card";
import { FeedPanel } from "@/components/booking/feed-panel";
import { PageIntro, Panel, StatGrid, StatTile, buttonOutlineAccent, buttonPrimary } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { listBookings } from "@/lib/bookings";
import { getFeedStatus } from "@/lib/feed";
import { getOwnProfileOrNull } from "@/lib/provider";
import { dateKeyInZone, formatDayLong } from "@/lib/slot-format";

export const metadata: Metadata = { title: "Provider calendar" };
export const dynamic = "force-dynamic";

/** The provider's agenda: bookings on their calendar, grouped by day in their own time zone. */
export default async function ProviderCalendarPage() {
  const user = await requireUserOrRedirect();
  const profile = await getOwnProfileOrNull(user);
  if (!profile) {
    return (
      <>
        <PageIntro section="Provider" title="Your calendar" description="Bookings customers make with you appear here." />
        <Panel title="Set up first">
          <p className="mb-4 text-muted">You haven&apos;t turned on bookings yet.</p>
          <Link href="/provider" className={buttonPrimary}>
            Set up your provider profile
          </Link>
        </Panel>
      </>
    );
  }

  const now = new Date();
  const [upcoming, past, feed] = await Promise.all([
    listBookings(user, { as: "provider", when: "upcoming", limit: 100 }, now),
    listBookings(user, { as: "provider", when: "past", limit: 20 }, now),
    getFeedStatus(user),
  ]);
  const zone = profile.timeZone;
  const days = new Map<string, typeof upcoming>();
  for (const booking of upcoming) {
    const key = dateKeyInZone(booking.startsAt, zone);
    days.set(key, [...(days.get(key) ?? []), booking]);
  }
  const confirmed = upcoming.filter((b) => b.status === "confirmed").length;

  return (
    <>
      <PageIntro
        section="Provider"
        title="Your calendar"
        description={`Bookings on your calendar, in ${zone}. Cancelling frees the time straight away.`}
        actions={
          <Link href="/provider" className={buttonOutlineAccent}>
            Provider setup
          </Link>
        }
      />
      <StatGrid>
        <StatTile value={confirmed} label="Upcoming bookings" tone="accent" />
        <StatTile value={upcoming.length - confirmed} label="Cancelled, upcoming times" />
      </StatGrid>

      <Panel title="Upcoming">
        {upcoming.length === 0 ? (
          <p className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted" data-empty="upcoming">
            No upcoming bookings yet. Share your booking page link to get started.
          </p>
        ) : (
          <div className="space-y-5" data-agenda>
            {[...days.entries()].map(([key, list]) => (
              <section key={key} aria-labelledby={`day-${key}`} className="space-y-2">
                <h3 id={`day-${key}`} className="text-sm font-semibold uppercase tracking-wide text-muted">
                  {formatDayLong(key)}
                </h3>
                <ul className="grid gap-3 lg:grid-cols-2">
                  {list.map((booking) => (
                    <BookingCard key={booking.id} booking={booking} now={now} zone={zone} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Panel>

      {past.length > 0 && (
        <Panel title="Recent past" count={past.length} collapsible defaultOpen={false} closedLabel="Show">
          <ul className="grid gap-3 lg:grid-cols-2">
            {past.map((booking) => (
              <BookingCard key={booking.id} booking={booking} now={now} zone={zone} />
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="Calendar link">
        <FeedPanel exists={feed.exists} createdAt={feed.createdAt} />
      </Panel>
    </>
  );
}
