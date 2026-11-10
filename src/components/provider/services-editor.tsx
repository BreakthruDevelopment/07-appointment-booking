"use client";

import { useState, useTransition } from "react";
import { deleteServiceAction, saveServiceAction } from "@/app/provider/actions";
import { buttonDanger, buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui/styles";
import { FormMessage, Hint, type Message } from "./form-parts";

export type ServiceValues = {
  id?: string;
  name: string;
  description: string;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  active: boolean;
};

const BLANK: ServiceValues = { name: "", description: "", durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, active: true };

function ServiceForm({ initial, onSaved }: { initial: ServiceValues; onSaved?: () => void }) {
  const [values, setValues] = useState(initial);
  const [message, setMessage] = useState<Message>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, startTransition] = useTransition();
  const set = <K extends keyof ServiceValues>(key: K, value: ServiceValues[K]) => setValues((v) => ({ ...v, [key]: value }));
  const uid = initial.id ?? "new";

  function save(event: React.FormEvent) {
    event.preventDefault();
    setMessage(null);
    startTransition(async () => {
      const result = await saveServiceAction(values);
      if (result.ok) {
        setMessage({ kind: "ok", text: "Saved." });
        onSaved?.();
      } else {
        setMessage({ kind: "error", text: result.error });
      }
    });
  }

  function remove() {
    if (!initial.id) return;
    setMessage(null);
    startTransition(async () => {
      const result = await deleteServiceAction(initial.id);
      if (!result.ok) {
        setMessage({ kind: "error", text: result.error });
        setConfirmDelete(false);
      }
    });
  }

  return (
    <form onSubmit={save} className="space-y-3" data-service-form={uid}>
      <label className={labelClass}>
        <span>Service name</span>
        <input value={values.name} onChange={(e) => set("name", e.target.value)} required maxLength={80} className={inputClass} />
      </label>
      <label className={labelClass}>
        <span>Description (optional)</span>
        <textarea value={values.description} onChange={(e) => set("description", e.target.value)} maxLength={500} rows={2} className={inputClass} />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className={labelClass}>
          <span>Length (minutes)</span>
          <input type="number" inputMode="numeric" min={15} max={240} step={5} value={values.durationMin} onChange={(e) => set("durationMin", Number(e.target.value))} required className={inputClass} />
          <Hint>15 to 240, steps of 5.</Hint>
        </label>
        <label className={labelClass}>
          <span>Buffer before</span>
          <input type="number" inputMode="numeric" min={0} max={60} value={values.bufferBeforeMin} onChange={(e) => set("bufferBeforeMin", Number(e.target.value))} className={inputClass} />
          <Hint>Minutes kept free before.</Hint>
        </label>
        <label className={labelClass}>
          <span>Buffer after</span>
          <input type="number" inputMode="numeric" min={0} max={60} value={values.bufferAfterMin} onChange={(e) => set("bufferAfterMin", Number(e.target.value))} className={inputClass} />
          <Hint>Minutes kept free after.</Hint>
        </label>
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
        <input type="checkbox" checked={values.active} onChange={(e) => set("active", e.target.checked)} className="size-5 accent-accent" />
        <span>Offered to customers</span>
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={buttonPrimary}>
          {pending ? "Saving…" : initial.id ? "Save service" : "Add service"}
        </button>
        {initial.id && !confirmDelete && (
          <button type="button" disabled={pending} className={buttonDanger} onClick={() => setConfirmDelete(true)}>
            Delete
          </button>
        )}
        {initial.id && confirmDelete && (
          <>
            <button type="button" disabled={pending} className={buttonDanger} onClick={remove}>
              Yes, delete {values.name || "this service"}
            </button>
            <button type="button" disabled={pending} className={buttonSecondary} onClick={() => setConfirmDelete(false)}>
              Keep it
            </button>
          </>
        )}
      </div>
      <FormMessage message={message} />
    </form>
  );
}

const MAX_SERVICES = 20;

export function ServicesEditor({ services }: { services: (ServiceValues & { id: string })[] }) {
  const [adding, setAdding] = useState(false);
  const [round, setRound] = useState(0);
  return (
    <div className="space-y-4">
      {services.length === 0 && !adding && <p className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">No services yet. Add one so customers have something to book.</p>}
      <ul className="space-y-4">
        {services.map((service) => (
          <li key={service.id} className="space-y-1 rounded-card border border-border p-4" data-service={service.id}>
            <h3 className="break-words font-semibold">
              {service.name}
              {!service.active && <span className="ml-2 text-sm font-normal text-muted">(hidden)</span>}
            </h3>
            <ServiceForm initial={service} />
          </li>
        ))}
      </ul>
      {adding ? (
        <div className="space-y-2 rounded-card border border-border-strong p-4">
          <h3 className="font-semibold">New service</h3>
          <ServiceForm
            key={round}
            initial={BLANK}
            onSaved={() => {
              setRound((r) => r + 1);
              setAdding(false);
            }}
          />
          <button type="button" className={buttonSecondary} onClick={() => setAdding(false)}>
            Cancel
          </button>
        </div>
      ) : (
        services.length < MAX_SERVICES && (
          <button type="button" className={buttonSecondary} onClick={() => setAdding(true)} data-action="add-service">
            Add a service
          </button>
        )
      )}
      {services.length >= MAX_SERVICES && <p className="text-sm text-muted">You&apos;ve reached the limit of {MAX_SERVICES} services.</p>}
    </div>
  );
}
