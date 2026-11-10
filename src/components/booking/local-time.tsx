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
