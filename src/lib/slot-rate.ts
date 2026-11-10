import { TooManyRequestsError } from "@/lib/errors";

const WINDOW_MS = 60_000;
const LIMIT = 60;
/** Hard cap on tracked addresses, so a flood of made-up keys can't make the map grow or each request scan it. */
const MAX_KEYS = 10_000;

/** In-memory sliding window per IP. One process, which matches Cloud Run's max of 1 instance. */
function createLimiter(limit: number, message: string) {
  const hits = new Map<string, number[]>();
  return {
    reset: () => hits.clear(),
    assert(ip: string, now = Date.now()): void {
      const key = ip || "unknown";
      const recent = (hits.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
      // Re-insert so Map order is least-recently-used first; evicting the first key is then O(1).
      hits.delete(key);
      if (recent.length >= limit) {
        hits.set(key, recent);
        throw new TooManyRequestsError(message);
      }
      recent.push(now);
      hits.set(key, recent);
      if (hits.size > MAX_KEYS) {
        const oldest = hits.keys().next().value;
        if (oldest !== undefined) hits.delete(oldest);
      }
    },
  };
}

const slotLimiter = createLimiter(LIMIT, "Too many slot requests. Try again in a minute.");
const feedLimiter = createLimiter(30, "Too many calendar requests. Try again in a minute.");

/** Test hook. */
export function resetSlotRate(): void {
  slotLimiter.reset();
  feedLimiter.reset();
}

/** 60 slot reads per IP per minute. A missing or odd address shares the "unknown" bucket. */
export function assertSlotRate(ip: string, now = Date.now()): void {
  slotLimiter.assert(ip, now);
}

/** 30 calendar-feed reads per IP per minute: far above any calendar app's polling, far below token guessing. */
export function assertFeedRate(ip: string, now = Date.now()): void {
  feedLimiter.assert(ip, now);
}

/** Cloud Run appends the real client address last; earlier entries are client-supplied and can't be trusted. */
export function clientIp(request: Request): string {
  const last = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ?? "";
  if (last.length > 0 && last.length <= 64) return last;
  return "unknown";
}
