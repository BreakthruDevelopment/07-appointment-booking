const FALLBACK = "/dashboard";

/** Percent-decode up to twice (so `%252e` is caught too); `null` when the text isn't valid percent-encoding. */
function decodeLayers(value: string): string[] | null {
  const layers = [value];
  try {
    for (let i = 0; i < 2; i += 1) layers.push(decodeURIComponent(layers[layers.length - 1]));
  } catch {
    return null;
  }
  return layers;
}

/**
 * Where to go after sign-in: only a plain same-site path, else the dashboard. Refused: anything not starting with a
 * single "/", "//" or a backslash anywhere (also once percent-decoded), "." and ".." segments (also encoded, as
 * `%2e%2e`), control characters, and a query string or fragment.
 */
export function safeNext(value: string | string[] | undefined): string {
  const next = Array.isArray(value) ? value[0] : value;
  if (typeof next !== "string" || next.length > 200 || !/^\/[\w\-./%]*$/.test(next)) return FALLBACK;
  const layers = decodeLayers(next);
  if (!layers) return FALLBACK;
  for (const layer of layers) {
    if (!layer.startsWith("/") || layer.includes("//") || layer.includes("\\")) return FALLBACK;
    if (/[\u0000-\u001f\u007f]/.test(layer)) return FALLBACK;
    if (layer.split("/").some((segment) => segment === "." || segment === "..")) return FALLBACK;
  }
  return next;
}
