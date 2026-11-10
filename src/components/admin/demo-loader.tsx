"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { buttonPrimary } from "@/components/ui/styles";

type Result = { slug: string; services: number; customers: number; bookings: number; dstDate: string };

/** Loads (or reloads) Demo Studio through the admin-only route. Only rows marked as demo data are replaced. */
export function DemoLoader({ loadsLeft }: { loadsLeft: number }) {
  const router = useRouter();
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function load() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/demo", { method: "POST" });
        const body = (await res.json().catch(() => ({}))) as Partial<Result> & { error?: string };
        if (!res.ok) {
          setError(body.error ?? "The demo didn't load. Try again.");
          return;
        }
        setResult(body as Result);
        router.refresh();
      } catch {
        setError("Couldn't reach the server. Check your connection and try again.");
      }
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Creates Demo Studio (America/Denver, 3 services, 2 sample customers) with bookings around the nearest daylight-saving change. Reloading replaces only demo rows.
        {loadsLeft >= 0 && ` ${loadsLeft} load${loadsLeft === 1 ? "" : "s"} left today.`}
      </p>
      <button type="button" className={buttonPrimary} disabled={pending || loadsLeft === 0} onClick={load} data-action="load-demo">
        {pending ? "Loading demo…" : "Load demo data"}
      </button>
      {result && (
        <p role="status" className="text-sm font-medium text-success" data-demo-result>
          Loaded {result.services} services, {result.customers} customers and {result.bookings} bookings (daylight-saving date {result.dstDate}).{" "}
          <Link href={`/p/${result.slug}`} className="text-accent underline underline-offset-2">
            Open the demo page
          </Link>
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
