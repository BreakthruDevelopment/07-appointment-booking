import type { Metadata } from "next";
import Link from "next/link";
import { FeedPanel } from "@/components/booking/feed-panel";
import { HoursEditor } from "@/components/provider/hours-editor";
import { OverridesEditor } from "@/components/provider/overrides-editor";
import { ProfileForm } from "@/components/provider/profile-form";
import { ServicesEditor } from "@/components/provider/services-editor";
import { PageIntro, Panel, StatusBadge, buttonOutlineAccent } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { todayInZone } from "@/lib/availability";
import { getFeedStatus } from "@/lib/feed";
import { getOwnProfileOrNull, listHours, listOverrides, listServices } from "@/lib/provider";

export const metadata: Metadata = { title: "Provider setup" };
export const dynamic = "force-dynamic";

/** Every IANA zone the browser knows, plus UTC (which `supportedValuesOf` leaves out). The server validates again. */
function zoneNames(): string[] {
  const zones = new Set(Intl.supportedValuesOf("timeZone"));
  zones.add("UTC");
  return [...zones].sort((a, b) => a.localeCompare(b));
}

export default async function ProviderPage() {
  const user = await requireUserOrRedirect();
  const profile = await getOwnProfileOrNull(user);
  const zones = zoneNames();

  if (!profile) {
    return (
      <>
        <PageIntro
          section="Provider"
          title="Accept bookings"
          description="Any account can publish a booking page. Start with a name and a link; then add services and your hours."
        />
        {/* Same key as the full page's profile panel, so the form keeps its state (and its "Saved" message) once the profile exists. */}
        <Panel key="profile" title="Profile and booking rules">
          <ProfileForm initial={null} zones={zones} />
        </Panel>
      </>
    );
  }

  const [services, hours, overrides, feed] = await Promise.all([listServices(user), listHours(user), listOverrides(user), getFeedStatus(user)]);
  const today = todayInZone(profile.timeZone, new Date());
  const live = profile.accepting && services.some((s) => s.active);

  return (
    <>
      <PageIntro
        key="intro"
        section="Provider"
        title="Provider setup"
        description="Your profile, services, opening hours and special dates. Customers book from the times these rules leave open."
        actions={
          <>
            {profile.accepting && (
              <Link href={`/p/${profile.slug}`} className={buttonOutlineAccent}>
                View your booking page
              </Link>
            )}
            <Link href="/provider/calendar" className={buttonOutlineAccent}>
              Open your calendar
            </Link>
          </>
        }
      />
      <div className="mb-6 flex flex-wrap items-center gap-2" data-provider-status={live ? "live" : "off"}>
        <StatusBadge status={live ? "live" : "not-started"} label={live ? "Page is live" : profile.accepting ? "Add an active service to go live" : "Bookings are switched off"} />
      </div>
      <Panel key="profile" title="Profile and booking rules">
        <ProfileForm initial={profile} zones={zones} />
      </Panel>
      <Panel title="Services" count={services.length}>
        <ServicesEditor services={services} />
      </Panel>
      <Panel title="Weekly hours">
        <p className="mb-4 text-sm text-muted">Times are in {profile.timeZone}. A day with no hours is closed. Add up to three intervals a day, for example a lunch break.</p>
        <HoursEditor hours={hours} />
      </Panel>
      <Panel title="Special dates">
        <p className="mb-4 text-sm text-muted">Close a day or set different hours for it. These replace the weekly hours on that date, in {profile.timeZone}.</p>
        <OverridesEditor overrides={overrides} today={today} />
      </Panel>
      <Panel title="Calendar link">
        <FeedPanel exists={feed.exists} createdAt={feed.createdAt} />
      </Panel>
    </>
  );
}
