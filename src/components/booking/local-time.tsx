"use client";

import { formatDateTime } from "@/lib/slot-format";
import { useViewerZone } from "./viewer-zone";

/**
 * An appointment time in the viewer's zone, with the provider's zone beneath it when they differ.
 * The server renders it in the provider's zone (it can't know the viewer's); the browser swaps in the viewer's.
 */
export function LocalTime({ iso, providerZone }: { iso: string; providerZone: string }) {
  const viewer = useViewerZone();
  const zone = viewer ?? providerZone;
  return (
    <>
      <time dateTime={iso} className="font-medium">
        {formatDateTime(iso, zone)}
      </time>
      {viewer && viewer !== providerZone && (
        <span className="block text-sm text-muted">
          {formatDateTime(iso, providerZone)} in {providerZone}
        </span>
      )}
    </>
  );
}

/**
 * One moment (for example the last time a booking can be cancelled online) in the viewer's zone, zone abbreviation
 * included. Before the browser's zone is known it shows the provider's zone, which is also what the server renders.
 */
export function LocalMoment({ iso, providerZone, hook }: { iso: string; providerZone: string; hook?: string }) {
  const viewer = useViewerZone();
  return (
    <time dateTime={iso} data-moment={hook}>
      {formatDateTime(iso, viewer ?? providerZone)}
    </time>
  );
}
