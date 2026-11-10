"use client";

import { useState, useTransition } from "react";
import { replaceHoursAction } from "@/app/provider/actions";
import { buttonPrimary } from "@/components/ui/styles";
import { intervalProblems } from "@/lib/provider-rules";
import { FormMessage, IntervalRows, type Interval, type Message } from "./form-parts";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export type HourRow = { weekday: number; startMin: number; endMin: number };

/** Weekly opening hours: one row per day (ISO 1 = Monday), each with up to three intervals. */
export function HoursEditor({ hours }: { hours: HourRow[] }) {
  const [days, setDays] = useState<Interval[][]>(() =>
    DAYS.map((_, i) => hours.filter((h) => h.weekday === i + 1).map((h) => ({ start: h.startMin, end: h.endMin })).sort((a, b) => a.start - b.start)),
  );
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();

  function save(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    for (let i = 0; i < DAYS.length; i++) {
      const problem = intervalProblems(days[i]);
      if (problem) {
        setMessage({ kind: "error", text: `${DAYS[i]}: ${problem}` });
        return;
      }
    }
    const payload = { hours: days.flatMap((list, i) => list.map((row) => ({ weekday: i + 1, startMin: row.start, endMin: row.end }))) };
    startTransition(async () => {
      const result = await replaceHoursAction(payload);
      setMessage(result.ok ? { kind: "ok", text: payload.hours.length === 0 ? "Saved. You're closed every day, so no times are offered." : "Saved." } : { kind: "error", text: result.error });
    });
  }

  return (
    <form onSubmit={save} className="space-y-4" data-form="hours">
      <ul className="divide-y divide-border">
        {DAYS.map((name, i) => (
          <li key={name} className="space-y-2 py-3 first:pt-0" data-weekday={i + 1}>
            <h3 className="font-semibold">
              {name}
              {days[i].length === 0 && <span className="ml-2 text-sm font-normal text-muted">Closed</span>}
            </h3>
            <IntervalRows name={name} intervals={days[i]} disabled={pending} onChange={(next) => setDays((all) => all.map((list, j) => (j === i ? next : list)))} />
          </li>
        ))}
      </ul>
      <button type="submit" disabled={pending} className={buttonPrimary}>
        {pending ? "Saving…" : "Save weekly hours"}
      </button>
      <FormMessage message={message} />
    </form>
  );
}
