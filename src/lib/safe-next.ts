/** Where to go after sign-in: only a same-site path (a leading "/" but not "//" or "/\"), else the dashboard. */
export function safeNext(value: string | string[] | undefined): string {
  const next = Array.isArray(value) ? value[0] : value;
  return typeof next === "string" && next.length <= 200 && /^\/(?![/\\])[\w\-./%]*$/.test(next) ? next : "/dashboard";
}
