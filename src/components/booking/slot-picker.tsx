"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { buttonOutlineAccent, buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui/styles";
import {
  addDays,
  chipLabels,
  dateKeyInZone,
  dayParts,
  dayStart,
  dayWindow,
  formatDateTime,
  formatDay,
  formatDayLong,
  groupByDay,
  zoneNote,
} from "@/lib/slot-format";
import { useViewerZone } from "./viewer-zone";

export type PickerService = { id: string; name: string; description: string; durationMin: number };

type Props = {
  slug: string;
  providerName: string;
  providerZone: string;
  horizonDays: number;
  services: PickerService[];
  /** Whether the viewer is signed in. Booking needs it; browsing times doesn't. */
  signedIn: boolean;
  /** The viewer owns this page, and createBooking refuses own services. */
  isOwner: boolean;
};

const DAYS = 7;
const SLOT_CAP = 200;
const NOTE_MAX = 300;

type Week = { key: string; keys: string[]; slots: string[]; truncated: boolean } | { key: string; error: string };
type Extra = { key: string; slots: string[] } | { key: string; error: string };
type Outcome =
  | { kind: "idle" }
  | { kind: "done"; id: string; startsAt: string; serviceName: string }
  | { kind: "error"; message: string; code?: string; fresh?: string[]; signIn?: boolean };

async function fetchSlots(slug: string, serviceId: string, from: Date, to: Date, signal: AbortSignal): Promise<string[]> {
  const url = `/api/providers/${encodeURIComponent(slug)}/slots?serviceId=${encodeURIComponent(serviceId)}&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
  const res = await fetch(url, { signal, cache: "no-store" });
  if (res.status === 429) throw new Error("Too many requests. Wait a minute and try again.");
  if (!res.ok) throw new Error("Couldn't load open times.");
  const body = (await res.json()) as { slots?: unknown };
  return Array.isArray(body.slots) ? body.slots.filter((s): s is string => typeof s === "string") : [];
}

/**
 * Service, day strip and time chips. Times are absolute UTC instants from the slots route; this component only
 * chooses the viewer's local days to ask about and how to show each instant. The booking itself is checked again
 * on the server, so what is shown here is an offer, not a promise: a 409 brings fresh times.
 */
export function SlotPicker({ slug, providerName, providerZone, horizonDays, services, signedIn, isOwner }: Props) {
  const viewerZone = useViewerZone();
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [weekOffset, setWeekOffset] = useState(0);
  const [tick, setTick] = useState(0);
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const [week, setWeek] = useState<Week | null>(null);
  const [extra, setExtra] = useState<Extra | null>(null);

  const service = services.find((s) => s.id === serviceId);
  const weekKey = viewerZone && serviceId ? `${serviceId}|${viewerZone}|${weekOffset}|${tick}` : null;
  const loading = weekKey !== null && week?.key !== weekKey;

  useEffect(() => {
    if (!weekKey || !viewerZone) return;
    const controller = new AbortController();
    const win = dayWindow(dateKeyInZone(new Date(), viewerZone), weekOffset * DAYS, DAYS, viewerZone);
    fetchSlots(slug, serviceId, win.from, win.to, controller.signal)
      .then((slots) => setWeek({ key: weekKey, keys: win.keys, slots, truncated: slots.length >= SLOT_CAP }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setWeek({ key: weekKey, error: err instanceof Error ? err.message : "Couldn't load open times." });
      });
    return () => controller.abort();
  }, [weekKey, viewerZone, slug, serviceId, weekOffset]);

  const ready = week && week.key === weekKey && "slots" in week ? week : null;
  const failure = week && week.key === weekKey && "error" in week ? week.error : null;

  const groups = ready && viewerZone ? groupByDay(ready.slots, viewerZone) : null;
  // When the 200-slot cap cut the week short, days from the last returned slot on are unknown, not empty.
  const lastKey = ready?.truncated && ready.slots.length > 0 && viewerZone ? dateKeyInZone(ready.slots[ready.slots.length - 1], viewerZone) : null;
  const unknown = (key: string) => lastKey !== null && key >= lastKey;

  const firstWithTimes = ready?.keys.find((k) => (groups?.get(k)?.length ?? 0) > 0);
  const day = ready ? (pickedDay && ready.keys.includes(pickedDay) ? pickedDay : (firstWithTimes ?? ready.keys[0])) : null;

  const extraKey = day && viewerZone && ready && unknown(day) ? `${weekKey}|${day}` : null;
  useEffect(() => {
    if (!extraKey || !day || !viewerZone) return;
    const controller = new AbortController();
    fetchSlots(slug, serviceId, dayStart(day, viewerZone), dayStart(addDays(day, 1), viewerZone), controller.signal)
      .then((slots) => setExtra({ key: extraKey, slots }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setExtra({ key: extraKey, error: err instanceof Error ? err.message : "Couldn't load open times." });
      });
    return () => controller.abort();
  }, [extraKey, day, viewerZone, slug, serviceId]);

  const extraReady = extra && extra.key === extraKey && "slots" in extra ? extra : null;
  const extraFailure = extra && extra.key === extraKey && "error" in extra ? extra.error : null;
  const dayLoading = extraKey !== null && !extraReady && !extraFailure;
  const daySlots = day && viewerZone ? (unknown(day) ? (extraReady?.slots ?? []) : (groups?.get(day) ?? [])) : [];
  const chips = viewerZone ? chipLabels(daySlots, viewerZone) : [];

  const canLater = (weekOffset + 1) * DAYS < horizonDays;

  function choose(next: string) {
    setSlot(next);
    setOutcome((current) => (current.kind === "done" ? { kind: "idle" } : current));
  }

  function changeService(id: string) {
    setServiceId(id);
    setSlot(null);
    setPickedDay(null);
    setOutcome({ kind: "idle" });
  }

  async function book() {
    if (!slot || !service) return;
    setPending(true);
    setOutcome({ kind: "idle" });
    try {
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serviceId: service.id, startsAt: slot, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      const body = (await res.json().catch(() => ({}))) as { booking?: { id: string; startsAt: string; serviceName: string }; error?: string; code?: string; slots?: unknown };
      if (res.status === 201 && body.booking) {
        setOutcome({ kind: "done", id: body.booking.id, startsAt: body.booking.startsAt, serviceName: body.booking.serviceName });
        setSlot(null);
        setNote("");
        setTick((t) => t + 1);
      } else if (res.status === 401) {
        setOutcome({ kind: "error", message: "Sign in to book this time.", signIn: true });
      } else {
        const fresh = Array.isArray(body.slots) ? body.slots.filter((s): s is string => typeof s === "string") : undefined;
        setOutcome({ kind: "error", message: body.error ?? "Couldn't book that time. Try again.", code: body.code, fresh });
        if (body.code === "slot_taken" || body.code === "slot_unavailable") {
          setSlot(null);
          setTick((t) => t + 1);
        }
      }
    } catch {
      setOutcome({ kind: "error", message: "Couldn't reach the server. Check your connection and try again." });
    } finally {
      setPending(false);
    }
  }

  if (services.length === 0) {
    return <p className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">{providerName} hasn&apos;t added any services yet. Check back soon.</p>;
  }

  const fresh = outcome.kind === "error" && outcome.fresh && viewerZone ? groupByDay(outcome.fresh, viewerZone) : null;

  return (
    <div className="space-y-6" data-slot-picker>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-semibold">1. Choose a service</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {services.map((s) => (
            <label
              key={s.id}
              className={`flex min-h-11 cursor-pointer gap-3 rounded-card border p-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ${
                s.id === serviceId ? "border-accent bg-accent-soft" : "border-border-strong bg-surface"
              }`}
            >
              <input type="radio" name="service" value={s.id} checked={s.id === serviceId} onChange={() => changeService(s.id)} className="mt-1 size-4 shrink-0 accent-accent" data-service-id={s.id} />
              <span className="min-w-0">
                <span className="block break-words font-semibold">{s.name}</span>
                <span className="block text-sm text-muted">{s.durationMin} min</span>
                {s.description && <span className="mt-1 block whitespace-pre-line break-words text-sm">{s.description}</span>}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <section aria-labelledby="pick-time" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="pick-time" className="text-sm font-semibold">
            2. Pick a day and time
          </h2>
          <div className="flex gap-2">
            <button type="button" className={buttonSecondary} disabled={weekOffset === 0} onClick={() => { setWeekOffset((w) => w - 1); setPickedDay(null); }}>
              Earlier
            </button>
            <button type="button" className={buttonSecondary} disabled={!canLater} onClick={() => { setWeekOffset((w) => w + 1); setPickedDay(null); }}>
              Later
            </button>
          </div>
        </div>

        {!viewerZone && <p className="text-sm text-muted">Finding your time zone…</p>}
        {viewerZone && <p className="text-sm text-muted" data-zone-note>{zoneNote(viewerZone, providerZone, providerName)}</p>}

        {loading && viewerZone && (
          <p role="status" className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">
            Loading open times…
          </p>
        )}
        {failure && (
          <div role="alert" className="space-y-2 rounded-card border border-border bg-blocked-soft px-4 py-3 text-sm text-blocked">
            <p>{failure}</p>
            <button type="button" className={buttonSecondary} onClick={() => setTick((t) => t + 1)}>
              Try again
            </button>
          </div>
        )}

        {ready && viewerZone && day && (
          <>
            <ul className="grid grid-cols-4 gap-2 sm:grid-cols-7" aria-label="Days">
              {ready.keys.map((key) => {
                const count = groups?.get(key)?.length ?? 0;
                const parts = dayParts(key);
                const selected = key === day;
                const label = unknown(key) ? "Check" : count === 0 ? "None" : `${count}`;
                return (
                  <li key={key}>
                    <button
                      type="button"
                      aria-pressed={selected}
                      aria-label={`${formatDayLong(key)}: ${unknown(key) ? "tap to check times" : count === 0 ? "no open times" : `${count} open times`}`}
                      onClick={() => setPickedDay(key)}
                      data-day={key}
                      data-count={unknown(key) ? "unknown" : count}
                      className={`flex min-h-16 w-full flex-col items-center justify-center rounded-card border px-1 py-1 text-center ${
                        selected ? "border-accent bg-accent text-accent-foreground" : count === 0 && !unknown(key) ? "border-border bg-background text-muted" : "border-border-strong bg-surface"
                      }`}
                    >
                      <span className="text-xs font-semibold uppercase">{parts.weekday}</span>
                      <span className="text-lg font-semibold leading-tight">{parts.day}</span>
                      <span className="text-xs">{label === "None" || label === "Check" ? label : `${label} open`}</span>
                    </button>
                  </li>
                );
              })}
            </ul>

            <div aria-live="polite" className="space-y-2">
              <h3 className="text-sm font-semibold">{formatDayLong(day)}</h3>
              {dayLoading && <p className="text-sm text-muted">Loading times…</p>}
              {extraFailure && <p role="alert" className="text-sm font-medium text-danger">{extraFailure}</p>}
              {!dayLoading && !extraFailure && chips.length === 0 && (
                <p className="rounded-card bg-background px-4 py-4 text-sm text-muted" data-empty-day>
                  {ready.slots.length === 0
                    ? `No open times in these ${DAYS} days. ${canLater ? "Try the next week." : "That is as far ahead as booking opens."}`
                    : "No open times this day. Pick another day."}
                </p>
              )}
              <ul className="flex flex-wrap gap-2" aria-label={`Open times on ${formatDay(day)}`}>
                {chips.map((chip) => (
                  <li key={chip.iso}>
                    <button
                      type="button"
                      aria-pressed={slot === chip.iso}
                      onClick={() => choose(chip.iso)}
                      data-slot={chip.iso}
                      className={`min-h-11 min-w-24 rounded-card border px-3 text-sm font-semibold ${
                        slot === chip.iso ? "border-accent bg-accent text-accent-foreground" : "border-border-strong bg-surface hover:bg-accent-soft"
                      }`}
                    >
                      {chip.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </section>

      <section aria-label="Booking" aria-live="polite" className="space-y-3">
        {outcome.kind === "done" && viewerZone && (
          <div role="status" className="space-y-3 rounded-card border border-border bg-live-soft p-4" data-booked={outcome.id}>
            <p className="font-semibold text-live">Booked: {outcome.serviceName}</p>
            <p>{formatDateTime(outcome.startsAt, viewerZone)}</p>
            <div className="flex flex-wrap gap-2">
              <a href={`/api/bookings/${outcome.id}/ics`} download className={buttonSecondary}>
                Add to calendar (.ics)
              </a>
              <Link href="/bookings" className={buttonOutlineAccent}>
                See my bookings
              </Link>
            </div>
          </div>
        )}

        {outcome.kind === "error" && (
          <div role="alert" className="space-y-3 rounded-card border border-border bg-blocked-soft p-4 text-blocked" data-error-code={outcome.code ?? "error"}>
            <p className="font-semibold">{outcome.message}</p>
            {outcome.code === "limit_reached" && (
              <Link href="/bookings" className={buttonSecondary}>
                Manage my bookings
              </Link>
            )}
            {outcome.signIn && (
              <Link href={`/sign-in?next=${encodeURIComponent(`/p/${slug}`)}`} className={buttonPrimary}>
                Sign in
              </Link>
            )}
            {fresh && fresh.size > 0 && viewerZone && (
              <div className="space-y-2 text-foreground" data-fresh-slots>
                <p className="text-sm font-semibold">Nearby open times</p>
                {[...fresh.entries()].map(([key, list]) => (
                  <div key={key} className="space-y-1">
                    <p className="text-sm text-muted">{formatDay(key)}</p>
                    <ul className="flex flex-wrap gap-2">
                      {chipLabels(list, viewerZone).map((chip) => (
                        <li key={chip.iso}>
                          <button type="button" onClick={() => choose(chip.iso)} data-fresh-slot={chip.iso} className="min-h-11 min-w-24 rounded-card border border-border-strong bg-surface px-3 text-sm font-semibold">
                            {chip.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            {fresh && fresh.size === 0 && <p className="text-sm text-foreground">There are no other open times nearby. Try another day above.</p>}
          </div>
        )}

        {slot && service && viewerZone && (
          <div className="space-y-4 rounded-card border border-border-strong bg-surface p-4" data-confirm>
            <h2 id="confirm-heading" className="text-sm font-semibold">
              3. Confirm
            </h2>
            <p>
              <span className="font-semibold">{service.name}</span> ({service.durationMin} min)
              <br />
              <time dateTime={slot}>{formatDateTime(slot, viewerZone)}</time>
              {viewerZone !== providerZone && <span className="block text-sm text-muted">{formatDateTime(slot, providerZone)} in {providerZone}</span>}
            </p>
            {isOwner ? (
              <p className="text-sm text-muted">This is your own page, so you can&apos;t book your own services.</p>
            ) : signedIn ? (
              <>
                <label className={labelClass}>
                  <span>Note for {providerName} (optional)</span>
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={NOTE_MAX} rows={3} className={inputClass} aria-describedby="note-count" />
                  <span id="note-count" className="block text-xs text-muted">
                    {note.length} / {NOTE_MAX}
                  </span>
                </label>
                <button type="button" onClick={book} disabled={pending} className={`${buttonPrimary} w-full sm:w-auto`} data-action="book">
                  {pending ? "Booking…" : "Confirm booking"}
                </button>
              </>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-muted">Sign in or create an account to book this time. It takes a minute.</p>
                <Link href={`/sign-in?next=${encodeURIComponent(`/p/${slug}`)}`} className={buttonPrimary} data-action="sign-in-to-book">
                  Sign in to book
                </Link>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
