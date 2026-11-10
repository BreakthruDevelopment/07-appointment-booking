import Link from "next/link";
import { DemoBadge, PageIntro, Panel, StatusBadge, buttonPrimary, buttonSecondary } from "@/components/ui";

const features = [
  { title: "Provider profile", body: "Any signed-in user can publish a link, services, weekly hours, and days they are closed or open late." },
  { title: "Open times", body: "Slots follow the provider's time zone, including daylight-saving gaps, with buffers, notice, and a booking horizon." },
  { title: "No double booking", body: "A confirmed appointment blocks that time. The database rejects a second booking that overlaps it." },
  { title: "Private setup", body: "Customers sign in to book. Another user, including an admin, cannot change a provider's hours or services." },
];

export default function Home() {
  return (
    <>
      <PageIntro
        section="Bookings"
        title="Publish your hours. Let people book a free time."
        description="Salons, clinics, tutors, and consultants share services and opening hours. Customers see real open slots in the provider's time zone."
        actions={
          <>
            <Link href="/sign-in" className={buttonPrimary}>
              Get started
            </Link>
            <Link href="/api/health" className={buttonSecondary}>
              Health check
            </Link>
          </>
        }
      />
      <div className="grid gap-x-4 sm:grid-cols-2">
        {features.map((f) => (
          <Panel key={f.title} title={f.title}>
            <p className="text-muted">{f.body}</p>
          </Panel>
        ))}
      </div>
      <Panel title="Status labels" action={<DemoBadge />}>
        <p className="mb-3 text-muted">
          The shared badges used across the portfolio. Not started is neutral, never an error.
        </p>
        <div className="flex flex-wrap gap-2">
          <StatusBadge status="live" />
          <StatusBadge status="building" />
          <StatusBadge status="blocked" />
          <StatusBadge status="not-started" />
        </div>
      </Panel>
    </>
  );
}
