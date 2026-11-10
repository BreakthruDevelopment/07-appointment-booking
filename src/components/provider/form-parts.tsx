"use client";

import type { ReactNode } from "react";
import { formatMinutes } from "@/lib/slot-format";
import { buttonSecondary, inputClass } from "@/components/ui/styles";

export type Message = { kind: "ok" | "error"; text: string } | null;

/** Saved / error text under a form. Errors are announced with role="alert", successes politely. */
export function FormMessage({ message }: { message: Message }) {
  if (!message) return <div aria-live="polite" />;
  return message.kind === "error" ? (
    <p role="alert" className="text-sm font-medium text-danger">
      {message.text}
    </p>
  ) : (
    <p role="status" className="text-sm font-medium text-success">
      {message.text}
    </p>
  );
}

export function Hint({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <span id={id} className="block text-xs font-normal text-muted">
      {children}
    </span>
  );
}

export type Interval = { start: number; end: number };

const MINUTES = Array.from({ length: 97 }, (_, i) => i * 15);

function TimeSelect({ prefix, label, value, onChange, from, to }: { prefix: string; label: string; value: number; onChange: (v: number) => void; from: number; to: number }) {
  return (
    <label className="block space-y-1 text-sm font-medium">
      <span>
        <span className="sr-only">{prefix} </span>
        {label}
      </span>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))} className={inputClass}>
        {MINUTES.filter((m) => m >= from && m <= to).map((m) => (
          <option key={m} value={m}>
            {formatMinutes(m)}
          </option>
        ))}
      </select>
    </label>
  );
}

const MAX_INTERVALS = 3;

/** Opening intervals for one day (weekly hours and date overrides share this): add and remove rows, no drag. */
export function IntervalRows({
  name,
  intervals,
  onChange,
  disabled,
}: {
  /** Names the day or date in labels, for screen readers: "Monday". */
  name: string;
  intervals: Interval[];
  onChange: (next: Interval[]) => void;
  disabled?: boolean;
}) {
  const set = (i: number, patch: Partial<Interval>) => onChange(intervals.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const add = () => {
    const last = intervals[intervals.length - 1];
    const start = last ? Math.min(last.end + 60, 1440 - 60) : 9 * 60;
    onChange([...intervals, { start, end: Math.min(start + (last ? 60 : 8 * 60), 1440) }]);
  };
  return (
    <div className="space-y-2">
      {intervals.map((row, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2" data-interval>
          <TimeSelect prefix={`${name}, interval ${i + 1},`} label="From" value={row.start} from={0} to={1425} onChange={(v) => set(i, { start: v })} />
          <TimeSelect prefix={`${name}, interval ${i + 1},`} label="To" value={row.end} from={15} to={1440} onChange={(v) => set(i, { end: v })} />
          <button
            type="button"
            className={`${buttonSecondary} w-11 px-0`}
            aria-label={`Remove interval ${i + 1} for ${name}`}
            disabled={disabled}
            onClick={() => onChange(intervals.filter((_, j) => j !== i))}
          >
            <span aria-hidden>×</span>
          </button>
        </div>
      ))}
      {intervals.length < MAX_INTERVALS && (
        <button type="button" className={buttonSecondary} disabled={disabled} onClick={add}>
          {intervals.length === 0 ? `Add hours for ${name}` : `Add another interval for ${name}`}
        </button>
      )}
    </div>
  );
}
