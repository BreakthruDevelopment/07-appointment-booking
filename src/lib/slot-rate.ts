import { TooManyRequestsError } from "@/lib/errors";

const WINDOW_MS = 60_000;
const LIMIT = 60;
const hits = new Map<string, number[]>();

/** Test hook. The limiter is in-memory, one process, which matches Cloud Run's max of 1 instance. */
export function resetSlotRate(): void {
  hits.clear();
}

/** 60 slot reads per IP per minute. A missing or odd address shares the "unknown" bucket. */
export function assertSlotRate(ip: string, now = Date.now()): void {
  const key = ip || "unknown";
  const recent = (hits.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= LIMIT) {
    hits.set(key, recent);
    throw new TooManyRequestsError("Too many slot requests. Try again in a minute.");
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) {
    for (const [entry, times] of hits) {
      const kept = times.filter((at) => now - at < WINDOW_MS);
      if (kept.length === 0) hits.delete(entry);
      else hits.set(entry, kept);
    }
  }
}

export function clientIp(request: Request): string {
  const first = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  if (first.length > 0 && first.length <= 64) return first;
  return "unknown";
}
