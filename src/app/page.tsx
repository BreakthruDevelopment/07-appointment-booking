import Link from "next/link";
import { PageIntro, Panel, buttonPrimary, buttonSecondary } from "@/components/ui";

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
              Sign in to book
            </Link>
            <Link href="/provider" className={buttonSecondary}>
              Offer bookings
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
      <Panel title="Find a provider">
        <p className="text-muted">
          Each provider has a page link of their own, at <span className="font-mono break-all">/p/their-link</span>. Open the
          link you were given, pick a service and a free time, and sign in to confirm.
        </p>
      </Panel>
    </>
  );
}
