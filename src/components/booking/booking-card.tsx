import type { ReactNode } from "react";
import Link from "next/link";
import { StatusBadge, buttonSecondary } from "@/components/ui";
import type { BookingView } from "@/lib/bookings";
import { formatDateTime } from "@/lib/slot-format";
import { CancelButton } from "./cancel-button";
import { LocalMoment, LocalTime } from "./local-time";

/**
 * One booking as a card. Everything user-written (service, provider and customer names, the note) is a plain
 * React text child, so it is escaped. `now` comes from the page so the server decides what is still cancellable.
 */
export function BookingCard({
  booking,
  now,
  zone,
}: {
  booking: BookingView;
  now: Date;
  /** Show the time in this zone on the server (the provider's agenda). Omit to show it in the viewer's zone. */
  zone?: string;
}) {
  const started = new Date(booking.startsAt).getTime() <= now.getTime();
  const confirmed = booking.status === "confirmed";
  const cancelOpen = confirmed && !started && new Date(booking.cancelBy).getTime() >= now.getTime();
  const provider = booking.role === "provider";
  const who = provider ? booking.customerName ?? "Customer" : booking.providerName;

  let badge: ReactNode;
  if (!confirmed) badge = <StatusBadge status="not-started" label={booking.cancelledBy === "provider" ? "Cancelled by provider" : "Cancelled"} />;
  else if (started) badge = <StatusBadge status="passed" label="Done" />;
  else badge = <StatusBadge status="live" label="Confirmed" />;

  return (
    <li
      className="space-y-3 rounded-card border border-border bg-surface p-4"
      data-booking-id={booking.id}
      data-status={booking.status}
      data-role={booking.role}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-words font-semibold">{booking.serviceName}</h3>
          <p className="break-words text-sm text-muted">
            {provider ? "With " : "At "}
            {provider ? (
              who
            ) : (
              <Link href={`/p/${booking.providerSlug}`} className="inline-flex min-h-11 items-center font-medium text-accent underline underline-offset-2">
                {who}
              </Link>
            )}
            {" · "}
            {booking.durationMin} min
          </p>
        </div>
        {badge}
      </div>
      <p>
        {zone ? <time dateTime={booking.startsAt}>{formatDateTime(booking.startsAt, zone)}</time> : <LocalTime iso={booking.startsAt} providerZone={booking.providerTz} />}
      </p>
      {booking.customerNote && provider && <p className="whitespace-pre-line break-words rounded-card bg-background px-3 py-2 text-sm">Note: {booking.customerNote}</p>}
      {confirmed && !started && !cancelOpen && !provider && (
        <p className="text-sm text-muted" data-cancel-closed>
          Online cancellation closed <LocalMoment iso={booking.cancelBy} providerZone={booking.providerTz} hook="cancel-by" />. Contact {booking.providerName} to change it.
        </p>
      )}
      {cancelOpen && !provider && (
        <p className="text-sm text-muted">You can cancel online until <LocalMoment iso={booking.cancelBy} providerZone={booking.providerTz} hook="cancel-by" />.</p>
      )}
      <div className="flex flex-wrap items-start gap-2">
        <a href={`/api/bookings/${booking.id}/ics`} download className={buttonSecondary} data-action="ics">
          Add to calendar (.ics)
        </a>
        {cancelOpen && <CancelButton bookingId={booking.id} by={booking.role} />}
      </div>
    </li>
  );
}
