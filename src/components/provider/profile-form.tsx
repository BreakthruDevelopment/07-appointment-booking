"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { saveProfileAction } from "@/app/provider/actions";
import { buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui/styles";
import { FormMessage, Hint, type Message } from "./form-parts";

export type ProfileValues = {
  slug: string;
  displayName: string;
  bio: string;
  timeZone: string;
  accepting: boolean;
  minNoticeMinutes: number;
  horizonDays: number;
};

const NOTICE_PRESETS: [number, string][] = [
  [0, "No minimum"],
  [60, "1 hour"],
  [120, "2 hours"],
  [240, "4 hours"],
  [720, "12 hours"],
  [1440, "1 day"],
  [2880, "2 days"],
  [10080, "1 week"],
];

export function noticeLabel(minutes: number): string {
  return NOTICE_PRESETS.find(([m]) => m === minutes)?.[1] ?? `${minutes} minutes`;
}

/** Profile, time zone and booking rules. The server validates everything again (slug, zone, ranges). */
export function ProfileForm({ initial, zones }: { initial: ProfileValues | null; zones: string[] }) {
  const [values, setValues] = useState<ProfileValues>(
    initial ?? { slug: "", displayName: "", bio: "", timeZone: "UTC", accepting: true, minNoticeMinutes: 60, horizonDays: 30 },
  );
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  const [savedSlug, setSavedSlug] = useState(initial?.slug ?? null);
  const set = <K extends keyof ProfileValues>(key: K, value: ProfileValues[K]) => setValues((v) => ({ ...v, [key]: value }));
  const zoneList = zones.includes(values.timeZone) ? zones : [values.timeZone, ...zones];
  const notice = NOTICE_PRESETS.some(([m]) => m === values.minNoticeMinutes) ? NOTICE_PRESETS : [[values.minNoticeMinutes, noticeLabel(values.minNoticeMinutes)] as [number, string], ...NOTICE_PRESETS];

  function pickDeviceZone() {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone && zones.includes(zone)) set("timeZone", zone);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const result = await saveProfileAction({ ...values, slug: values.slug.trim().toLowerCase() });
      if (result.ok) {
        setSavedSlug(result.profile.slug);
        setValues(result.profile);
        const next = initial ? "" : " Next, add a service and your opening hours.";
        setMessage({ kind: "ok", text: `${result.profile.accepting ? "Saved." : "Saved. Bookings are switched off, so your page is hidden."}${next}` });
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4" data-form="profile">
      <label className={labelClass}>
        <span>Display name</span>
        <input value={values.displayName} onChange={(e) => set("displayName", e.target.value)} required maxLength={80} autoComplete="organization" className={inputClass} />
      </label>
      <label className={labelClass}>
        <span>Page link</span>
        <input
          value={values.slug}
          onChange={(e) => set("slug", e.target.value)}
          required
          minLength={3}
          maxLength={40}
          pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={inputClass}
          aria-describedby="slug-hint"
        />
        <Hint id="slug-hint">Your page is at /p/{values.slug || "your-link"}. Lowercase letters, numbers and hyphens, 3 to 40 characters.</Hint>
      </label>
      <label className={labelClass}>
        <span>About</span>
        <textarea value={values.bio} onChange={(e) => set("bio", e.target.value)} maxLength={500} rows={3} className={inputClass} aria-describedby="bio-count" />
        <Hint id="bio-count">{values.bio.length} / 500. Shown as plain text on your page.</Hint>
      </label>
      <div className="space-y-2">
        <label className={labelClass}>
          <span>Time zone</span>
          <select value={values.timeZone} onChange={(e) => set("timeZone", e.target.value)} className={inputClass} aria-describedby="tz-hint">
            {zoneList.map((zone) => (
              <option key={zone} value={zone}>
                {zone.replaceAll("_", " ")}
              </option>
            ))}
          </select>
          <Hint id="tz-hint">Your opening hours are wall-clock times in this zone. Customers see times in their own.</Hint>
        </label>
        <button type="button" className={buttonSecondary} onClick={pickDeviceZone}>
          Use this device&apos;s time zone
        </button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={labelClass}>
          <span>Minimum notice</span>
          <select value={values.minNoticeMinutes} onChange={(e) => set("minNoticeMinutes", Number(e.target.value))} className={inputClass} aria-describedby="notice-hint">
            {notice.map(([minutes, label]) => (
              <option key={minutes} value={minutes}>
                {label}
              </option>
            ))}
          </select>
          <Hint id="notice-hint">Nobody can book sooner than this, and customers can cancel online until this long before the start.</Hint>
        </label>
        <label className={labelClass}>
          <span>Book up to (days ahead)</span>
          <input type="number" inputMode="numeric" min={1} max={60} value={values.horizonDays} onChange={(e) => set("horizonDays", Number(e.target.value))} required className={inputClass} />
          <Hint>1 to 60 days.</Hint>
        </label>
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
        <input type="checkbox" checked={values.accepting} onChange={(e) => set("accepting", e.target.checked)} className="size-5 accent-accent" />
        <span>Accept bookings (publishes your page)</span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={buttonPrimary}>
          {pending ? "Saving…" : initial || savedSlug ? "Save profile" : "Create profile"}
        </button>
        {savedSlug && values.accepting && (
          <Link href={`/p/${savedSlug}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline underline-offset-2">
            View your page
          </Link>
        )}
      </div>
      <FormMessage message={message} />
    </form>
  );
}
