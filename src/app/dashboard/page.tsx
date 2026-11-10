import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro, Panel, buttonOutlineAccent, buttonPrimary } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { listBookings } from "@/lib/bookings";
import { getOwnProfileOrNull } from "@/lib/provider";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

/** Signed-in home: what's coming up, and where to set up or manage. */
export default async function DashboardPage() {
  const user = await requireUserOrRedirect();
  const now = new Date();
  const [mine, onMyCalendar, profile] = await Promise.all([
    listBookings(user, { as: "customer", when: "upcoming", limit: 100 }, now),
    listBookings(user, { as: "provider", when: "upcoming", limit: 100 }, now),
    getOwnProfileOrNull(user),
  ]);
  const mineConfirmed = mine.filter((b) => b.status === "confirmed").length;
  const calendarConfirmed = onMyCalendar.filter((b) => b.status === "confirmed").length;

  return (
    <>
      <PageIntro section="Dashboard" title={`Hi, ${user.name}`} description={`Signed in as ${user.email}. Role: ${user.role}.`} />
      <div className="grid gap-x-4 md:grid-cols-2">
        <Panel title="My bookings">
          <p className="mb-4 text-muted" data-count="my-upcoming">
            {mineConfirmed === 0 ? "No upcoming appointments." : `${mineConfirmed} upcoming appointment${mineConfirmed === 1 ? "" : "s"}.`}
          </p>
          <Link href="/bookings" className={buttonPrimary}>
            See my bookings
          </Link>
        </Panel>
        <Panel title="Provider">
          {profile ? (
            <>
              <p className="mb-4 text-muted" data-count="calendar-upcoming">
                {calendarConfirmed === 0 ? "No upcoming bookings on your calendar." : `${calendarConfirmed} upcoming booking${calendarConfirmed === 1 ? "" : "s"} on your calendar.`}
              </p>
              <div className="flex flex-wrap gap-2">
                <Link href="/provider/calendar" className={buttonPrimary}>
                  Open your calendar
                </Link>
                <Link href="/provider" className={buttonOutlineAccent}>
                  Provider setup
                </Link>
              </div>
            </>
          ) : (
            <>
              <p className="mb-4 text-muted">Publish your hours and let customers book a free time.</p>
              <Link href="/provider" className={buttonPrimary}>
                Accept bookings
              </Link>
            </>
          )}
        </Panel>
      </div>
    </>
  );
}
