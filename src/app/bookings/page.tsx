import type { Metadata } from "next";
import Link from "next/link";
import { BookingCard } from "@/components/booking/booking-card";
import { PageIntro, Panel, buttonOutlineAccent } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { listBookings } from "@/lib/bookings";

export const metadata: Metadata = { title: "My bookings" };
export const dynamic = "force-dynamic";

/** The signed-in user's bookings as a customer. Times show in the viewer's zone (the browser swaps it in). */
export default async function BookingsPage() {
  const user = await requireUserOrRedirect();
  const now = new Date();
  const [upcoming, past] = await Promise.all([
    listBookings(user, { as: "customer", when: "upcoming", limit: 50 }, now),
    listBookings(user, { as: "customer", when: "past", limit: 20 }, now),
  ]);

  return (
    <>
      <PageIntro
        section="Bookings"
        title="My bookings"
        description="Appointments you've booked. Download one to your calendar, or cancel it before the provider's cutoff."
        actions={
          <Link href="/provider/calendar" className={buttonOutlineAccent}>
            Bookings on my provider calendar
          </Link>
        }
      />
      <Panel title="Upcoming" count={upcoming.length}>
        {upcoming.length === 0 ? (
          <p className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted" data-empty="upcoming">
            Nothing booked. Open a provider&apos;s booking page and pick a time; it will show up here.
          </p>
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2" data-list="upcoming">
            {upcoming.map((booking) => (
              <BookingCard key={booking.id} booking={booking} now={now} />
            ))}
          </ul>
        )}
      </Panel>
      {past.length > 0 && (
        <Panel title="Past and cancelled" count={past.length} collapsible defaultOpen={false} closedLabel="Show">
          <ul className="grid gap-3 lg:grid-cols-2" data-list="past">
            {past.map((booking) => (
              <BookingCard key={booking.id} booking={booking} now={now} />
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
