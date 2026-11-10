"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { buttonDanger, buttonSecondary } from "@/components/ui";

/**
 * Cancel one booking: ask once, post to the route (which re-checks the cutoff and ownership), refresh.
 * `by` only changes the wording; the server decides who may cancel and until when.
 */
export function CancelButton({ bookingId, by }: { bookingId: string; by: "customer" | "provider" }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function cancel() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/bookings/${bookingId}/cancel`, { method: "POST" });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? "Couldn't cancel. Try again.");
          return;
        }
        setAsking(false);
        router.refresh();
      } catch {
        setError("Couldn't reach the server. Check your connection and try again.");
      }
    });
  }

  if (!asking) {
    return (
      <button type="button" className={buttonDanger} onClick={() => setAsking(true)} data-action="cancel">
        Cancel booking
      </button>
    );
  }
  return (
    <div className="space-y-2" role="group" aria-label="Confirm cancellation">
      <p className="text-sm">
        {by === "provider"
          ? "Cancel this appointment? The customer isn't emailed, so tell them yourself."
          : "Cancel this appointment? The time goes back to the provider."}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonDanger} disabled={pending} onClick={cancel} data-action="confirm-cancel">
          {pending ? "Cancelling…" : "Yes, cancel it"}
        </button>
        <button type="button" className={buttonSecondary} disabled={pending} onClick={() => setAsking(false)}>
          Keep it
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
