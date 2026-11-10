"use client";

import { useRef, useState, useTransition } from "react";
import { buttonDanger, buttonPrimary, buttonSecondary, inputClass } from "@/components/ui/styles";
import { formatDateTime } from "@/lib/slot-format";
import { useViewerZone } from "./viewer-zone";

/**
 * The provider's private calendar link. The server only ever hands the URL out in the response to creating or
 * rotating it, so it lives in this component's memory until you leave the page: it is not saved anywhere and
 * a reload can't show it again. Anyone holding the link can read the calendar, hence the warning.
 */
export function FeedPanel({ exists, createdAt }: { exists: boolean; createdAt: string | null }) {
  const viewerZone = useViewerZone();
  const [url, setUrl] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(createdAt);
  const [has, setHas] = useState(exists);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();
  const input = useRef<HTMLInputElement>(null);

  function create() {
    setError(null);
    setCopied(false);
    startTransition(async () => {
      try {
        const res = await fetch("/api/provider/feed", { method: "POST" });
        const body = (await res.json().catch(() => ({}))) as { url?: string; createdAt?: string; error?: string };
        if (!res.ok || !body.url) {
          setError(body.error ?? "Couldn't make the calendar link. Try again.");
          return;
        }
        setUrl(body.url);
        setMade(body.createdAt ?? null);
        setHas(true);
        setAsking(false);
      } catch {
        setError("Couldn't reach the server. Check your connection and try again.");
      }
    });
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      input.current?.select();
    }
  }

  return (
    <div className="space-y-4" data-feed-exists={has ? "true" : "false"}>
      <p className="text-sm">
        Subscribe to this link in Google Calendar, Apple Calendar or Outlook to see your bookings there. It lists confirmed bookings from 30 days back to 60 days ahead, plus recent cancellations, with each customer&apos;s first name only.
        Calendar apps refresh subscribed links on their own schedule, and Google Calendar can take several hours.
      </p>
      <p role="note" className="rounded-card border border-border bg-building-soft px-3 py-2 text-sm font-medium text-building">
        Keep this link private. Anyone who has it can read your calendar, and it can&apos;t be limited to one person. If it leaks, make a new link: the old one stops working at once.
      </p>

      {url && (
        <div className="space-y-2" role="status" data-feed-url-box>
          <label className="block space-y-1 text-sm font-medium">
            <span>Your calendar link (shown once, copy it now)</span>
            <input ref={input} readOnly value={url} onFocus={(e) => e.currentTarget.select()} className={`${inputClass} font-mono text-sm`} data-feed-url />
          </label>
          <button type="button" className={buttonSecondary} onClick={copy}>
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}

      {!url && has && (
        <p className="text-sm text-muted">
          A calendar link is active{made && viewerZone ? `, made ${formatDateTime(made, viewerZone)}` : ""}. For safety it can&apos;t be shown again. Make a new link if you need it.
        </p>
      )}

      {!has && (
        <button type="button" className={buttonPrimary} disabled={pending} onClick={create} data-action="create-feed">
          {pending ? "Making link…" : "Make my calendar link"}
        </button>
      )}
      {has && !asking && (
        <button type="button" className={buttonSecondary} disabled={pending} onClick={() => setAsking(true)} data-action="rotate-feed">
          Make a new link
        </button>
      )}
      {has && asking && (
        <div className="space-y-2" role="group" aria-label="Confirm new calendar link">
          <p className="text-sm">The current link stops working immediately, and any calendar subscribed to it will stop updating until you subscribe again.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonDanger} disabled={pending} onClick={create} data-action="confirm-rotate">
              {pending ? "Making link…" : "Yes, replace it"}
            </button>
            <button type="button" className={buttonSecondary} disabled={pending} onClick={() => setAsking(false)}>
              Keep the current link
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
