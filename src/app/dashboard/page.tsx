import type { Metadata } from "next";
import { PageIntro, Panel } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

/** Signed-in home. Provider setup and the booking calendar are later pages. */
export default async function DashboardPage() {
  const user = await requireUserOrRedirect();
  return (
    <>
      <PageIntro
        section="Dashboard"
        title={`Hi, ${user.name}`}
        description={`Signed in as ${user.email}. Role: ${user.role}.`}
      />
      <Panel title="Bookings">
        <p className="text-muted">
          Your account is ready. Publishing hours and picking a time happen on the provider and booking pages.
        </p>
      </Panel>
    </>
  );
}
