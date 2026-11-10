"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * The viewer's IANA zone from the browser. `null` on the server and during hydration, so server HTML and the
 * first client render agree; React then re-renders with the real zone.
 */
export function useViewerZone(): string | null {
  return useSyncExternalStore(subscribe, browserZone, () => null);
}
