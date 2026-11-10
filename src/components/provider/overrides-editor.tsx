"use client";

import { useState, useTransition } from "react";
import { replaceOverridesAction } from "@/app/provider/actions";
import { buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui/styles";
import { intervalProblems } from "@/lib/provider-rules";
import { formatDay } from "@/lib/slot-format";
import { FormMessage, Hint, IntervalRows, type Interval, type Message } from "./form-parts";

export type OverrideRow = { date: string; closed: boolean; intervals: Interval[] };

const MAX_FUTURE = 60;

/**
 * Date overrides: a date that is closed, or open different hours, in place of the weekly hours.
 * Dates are the provider's own calendar days. Past dates are dropped on save (they can't affect anything).
 */
export function OverridesEditor({ overrides, today }: { overrides: OverrideRow[]; today: string }) {
  const [rows, setRows] = useState<OverrideRow[]>(() => overrides.filter((o) => o.date >= today).map((o) => ({ ...o, intervals: o.intervals ?? [] })));
  const [message, setMessage] = useState<Message>(null);
  const [pending, startTransition] = useTransition();
  const patch = (i: number, change: Partial<OverrideRow>) => setRows((all) => all.map((row, j) => (j === i ? { ...row, ...change } : row)));

  function save(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row.date) return setMessage({ kind: "error", text: "Pick a date for every row, or remove the empty one." });
      if (row.date < today) return setMessage({ kind: "error", text: `${row.date} is in the past.` });
      if (seen.has(row.date)) return setMessage({ kind: "error", text: `${formatDay(row.date)} appears twice. Each date can have one override.` });
      seen.add(row.date);
      if (!row.closed) {
        if (row.intervals.length === 0) return setMessage({ kind: "error", text: `${formatDay(row.date)}: add hours, or mark the day closed.` });
        const problem = intervalProblems(row.intervals);
        if (problem) return setMessage({ kind: "error", text: `${formatDay(row.date)}: ${problem}` });
      }
    }
    const payload = { overrides: rows.map((row) => ({ date: row.date, closed: row.closed, intervals: row.closed ? [] : row.intervals })) };
    startTransition(async () => {
      const result = await replaceOverridesAction(payload);
      if (result.ok) {
        setRows(result.overrides.map((o) => ({ ...o, intervals: o.intervals ?? [] })));
        setMessage({ kind: "ok", text: "Saved." });
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  }

  return (
    <form onSubmit={save} className="space-y-4" data-form="overrides">
      {rows.length === 0 && <p className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">No special dates. Add one for a holiday or a day with different hours.</p>}
      <ul className="space-y-4">
        {rows.map((row, i) => (
          <li key={i} className="space-y-3 rounded-card border border-border p-4" data-override={row.date}>
            <label className={labelClass}>
              <span>Date</span>
              <input type="date" value={row.date} min={today} onChange={(e) => patch(i, { date: e.target.value })} required className={inputClass} />
            </label>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">That day</legend>
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input type="radio" name={`override-${i}`} checked={row.closed} onChange={() => patch(i, { closed: true })} className="size-5 accent-accent" />
                <span>Closed all day</span>
              </label>
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input
                  type="radio"
                  name={`override-${i}`}
                  checked={!row.closed}
                  onChange={() => patch(i, { closed: false, intervals: row.intervals.length ? row.intervals : [{ start: 9 * 60, end: 17 * 60 }] })}
                  className="size-5 accent-accent"
                />
                <span>Open different hours</span>
              </label>
            </fieldset>
            {!row.closed && <IntervalRows name={row.date ? formatDay(row.date) : `row ${i + 1}`} intervals={row.intervals} disabled={pending} onChange={(next) => patch(i, { intervals: next })} />}
            <button type="button" className={buttonSecondary} onClick={() => setRows((all) => all.filter((_, j) => j !== i))}>
              Remove {row.date ? formatDay(row.date) : "this row"}
            </button>
          </li>
        ))}
      </ul>
      <Hint>Up to {MAX_FUTURE} upcoming dates. A date here replaces that weekday&apos;s hours.</Hint>
      <div className="flex flex-wrap gap-2">
        {rows.length < MAX_FUTURE && (
          <button type="button" className={buttonSecondary} data-action="add-override" onClick={() => setRows((all) => [...all, { date: "", closed: true, intervals: [] }])}>
            Add a date
          </button>
        )}
        <button type="submit" disabled={pending} className={buttonPrimary}>
          {pending ? "Saving…" : "Save dates"}
        </button>
      </div>
      <FormMessage message={message} />
    </form>
  );
}
