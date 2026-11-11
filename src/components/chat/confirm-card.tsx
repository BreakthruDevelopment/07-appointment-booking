"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { buttonOutlineAccent, buttonPrimary, buttonSecondary } from "@/components/ui/styles";
import { LocalTime } from "@/components/booking/local-time";
import { cardLabels, DISMISS_LABEL, effectiveStatus, freshTimePrompt, interpretConfirm, interpretDismiss, type Proposal } from "@/lib/chat-client";
import { formatDateTime } from "@/lib/slot-format";

type Phase =
  | { kind: "idle" }
  | { kind: "pending"; what: "confirm" | "dismiss" }
  | { kind: "done"; action: "booked" | "cancelled"; bookingId: string | null }
  | { kind: "dismissed" }
  | { kind: "taken"; message: string; fresh: string[] }
  | { kind: "closed"; message: string };

type Failure = { message: string; signIn?: boolean; limit?: boolean } | null;

type Props = {
  proposal: Proposal;
  slug: string;
  viewerZone: string | null;
  /** Not the newest card, so the server has already closed it. */
  superseded: boolean;
  /** The panel is busy sending a message. */
  busy: boolean;
  /** Send a plain-text message to the assistant (used for fresh times after a 409). */
  onAsk: (text: string) => void;
};

/**
 * The confirm card. Everything shown comes from the proposal row the server built (service, time, kind), never from
 * the assistant's words. Tapping Confirm calls POST /api/bookings { proposalId }; the server books (or cancels) the
 * stored values, so nothing on this card can change what happens.
 */
export function ConfirmCard({ proposal, slug, viewerZone, superseded, busy, onAsk }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [failure, setFailure] = useState<Failure>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const labels = cardLabels(proposal.kind);
  const takenRef = useRef<HTMLDivElement>(null);

  // The fresh times can land below the visible part of the message list on a phone: bring them into view and move
  // focus to the alert so keyboard and screen-reader users start from it.
  const takenNow = phase.kind === "taken";
  useEffect(() => {
    if (!takenNow) return;
    takenRef.current?.focus();
    takenRef.current?.scrollIntoView({ block: "nearest" });
  }, [takenNow]);

  // Flip an open card to "expired" at its own expiry time.
  useEffect(() => {
    if (proposal.status !== "open") return;
    const wait = Date.parse(proposal.expiresAt) - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setNowMs(Date.now()), Math.min(wait + 50, 2_147_000_000));
    return () => clearTimeout(timer);
  }, [proposal.status, proposal.expiresAt]);

  const status = effectiveStatus(proposal, nowMs);
  const pending = phase.kind === "pending";

  async function confirm() {
    setPhase({ kind: "pending", what: "confirm" });
    setFailure(null);
    try {
      const res = await fetch("/api/bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proposalId: proposal.id }) });
      const body: unknown = await res.json().catch(() => null);
      const outcome = interpretConfirm(res.status, body);
      if (outcome.kind === "done") setPhase({ kind: "done", action: outcome.action, bookingId: outcome.bookingId });
      else if (outcome.kind === "taken") setPhase({ kind: "taken", message: outcome.message, fresh: outcome.fresh });
      else if (outcome.kind === "closed") setPhase({ kind: "closed", message: outcome.message });
      else {
        setPhase({ kind: "idle" });
        setFailure({ message: outcome.message, signIn: outcome.signIn, limit: outcome.code === "limit_reached" });
      }
    } catch {
      setPhase({ kind: "idle" });
      setFailure({ message: "Couldn't reach the server. Check your connection and try again." });
    }
  }

  async function dismiss() {
    setPhase({ kind: "pending", what: "dismiss" });
    setFailure(null);
    try {
      const res = await fetch(`/api/proposals/${encodeURIComponent(proposal.id)}/dismiss`, { method: "POST" });
      const outcome = interpretDismiss(res.status);
      if (outcome.ok) setPhase({ kind: "dismissed" });
      else {
        setPhase({ kind: "idle" });
        setFailure({ message: outcome.message ?? "Couldn't dismiss that. Try again.", signIn: res.status === 401 });
      }
    } catch {
      setPhase({ kind: "idle" });
      setFailure({ message: "Couldn't reach the server. Check your connection and try again." });
    }
  }

  const finished = phase.kind === "done" || phase.kind === "dismissed" || phase.kind === "closed" || phase.kind === "taken";
  const actionable = !finished && !superseded && status === "open";
  let state: string = status;
  if (phase.kind === "done") state = phase.action;
  else if (phase.kind === "dismissed") state = "dismissed";
  else if (phase.kind === "taken") state = "taken";
  else if (phase.kind === "closed") state = "closed";
  else if (superseded && status === "open") state = "superseded";

  const when = proposal.startsAt;
  const bookingsHref = "/bookings";

  return (
    <div
      className="space-y-3 rounded-card border border-border-strong bg-surface p-4"
      data-confirm-card
      data-proposal-id={proposal.id}
      data-kind={proposal.kind}
      data-state={state}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-accent-soft px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-accent" data-card-badge>
          {labels.badge}
        </span>
        <h3 className="text-sm font-semibold">{labels.heading}</h3>
      </div>
      <p className="break-words">
        <span className="font-semibold">{proposal.serviceName ?? "Appointment"}</span>
        {proposal.durationMin ? ` (${proposal.durationMin} min)` : ""}
        <span className="block text-sm text-muted">with {proposal.providerName}</span>
      </p>
      {when && (
        <p>
          <LocalTime iso={when} providerZone={proposal.providerTz} />
        </p>
      )}

      {phase.kind === "done" && (
        <div role="status" className="space-y-3 rounded-card border border-border bg-live-soft p-3" data-card-result={phase.action}>
          <p className="font-semibold text-live">{phase.action === "booked" ? "Booked. You're all set." : "Cancelled. That appointment is off your list."}</p>
          <div className="flex flex-wrap gap-2">
            {phase.action === "booked" && phase.bookingId && (
              <a href={`/api/bookings/${encodeURIComponent(phase.bookingId)}/ics`} download className={buttonSecondary}>
                Add to calendar (.ics)
              </a>
            )}
            <Link href={bookingsHref} className={buttonOutlineAccent}>
              See my bookings
            </Link>
          </div>
        </div>
      )}
      {phase.kind === "dismissed" && (
        <p role="status" className="text-sm text-muted" data-card-result="dismissed">
          Dismissed. Nothing was {proposal.kind === "cancel" ? "cancelled" : "booked"}.
        </p>
      )}
      {phase.kind === "closed" && (
        <p role="alert" className="rounded-card border border-border bg-blocked-soft px-3 py-2 text-sm text-blocked" data-card-result="closed">
          {phase.message}
        </p>
      )}
      {phase.kind === "taken" && (
        <div ref={takenRef} tabIndex={-1} role="alert" className="space-y-3 rounded-card border border-border bg-blocked-soft p-3 text-blocked outline-offset-2" data-card-result="taken">
          <p className="font-semibold">{phase.message}</p>
          <div className="space-y-2 text-foreground" data-fresh-times>
            {phase.fresh.length > 0 && viewerZone ? (
              <>
                <p className="text-sm font-semibold">Other open times. Tap one and the assistant will set it up.</p>
                <ul className="flex flex-wrap gap-2">
                  {phase.fresh.map((iso) => (
                    <li key={iso}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onAsk(freshTimePrompt(proposal.serviceName, iso, viewerZone))}
                        data-fresh-slot={iso}
                        className="min-h-11 rounded-card border border-border-strong bg-surface px-3 text-sm font-semibold hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {formatDateTime(iso, viewerZone)}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-sm">There are no other open times nearby.</p>
            )}
            <button type="button" disabled={busy} onClick={() => onAsk("What other times are open?")} className={buttonSecondary}>
              Ask for other times
            </button>
          </div>
        </div>
      )}

      {failure && (
        <div role="alert" className="space-y-2 rounded-card border border-border bg-blocked-soft px-3 py-2 text-sm text-blocked" data-card-error>
          <p>{failure.message}</p>
          {failure.limit && (
            <Link href={bookingsHref} className={buttonSecondary}>
              Manage my bookings
            </Link>
          )}
          {failure.signIn && (
            <Link href={`/sign-in?next=${encodeURIComponent(`/p/${slug}/chat`)}`} className={buttonPrimary}>
              Sign in
            </Link>
          )}
        </div>
      )}

      {!finished && superseded && status === "open" && <p className="text-sm text-muted">Replaced by a newer suggestion below.</p>}
      {!finished && status === "expired" && !superseded && (
        <p className="text-sm text-muted" data-card-result="expired">
          This card expired. Ask the assistant again.
        </p>
      )}
      {!finished && status === "used" && <p className="text-sm text-muted">{proposal.kind === "cancel" ? "Confirmed: this appointment was cancelled." : "Confirmed: this time was booked."}</p>}

      {actionable && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <button type="button" onClick={confirm} disabled={pending || busy} className={`${buttonPrimary} w-full sm:w-auto`} data-action="confirm-card">
            {phase.kind === "pending" && phase.what === "confirm" ? labels.pending : labels.confirm}
          </button>
          <button type="button" onClick={dismiss} disabled={pending || busy} className={`${buttonSecondary} w-full sm:w-auto`} data-action="dismiss-card">
            {phase.kind === "pending" && phase.what === "dismiss" ? "Dismissing…" : DISMISS_LABEL}
          </button>
        </div>
      )}
    </div>
  );
}
