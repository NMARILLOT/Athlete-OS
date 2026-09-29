/**
 * Post-login redirect target taken from `?next=`. Only a same-origin absolute path is accepted
 * (open-redirect guard): `https://evil.example`, `//evil.example`, `/\evil.example` and any value
 * carrying control characters (which the URL parser would strip into one of those forms) fall back.
 * The proxy emits `pathname + search` and the (app) pages plain pathnames, so nothing legitimate
 * is lost; the result is a path (query and hash kept) to resolve with `new URL(path, origin)`.
 */
export const DEFAULT_NEXT_PATH = "/today";

const FAKE_ORIGIN = "https://athlete-os.invalid";
const MAX_LENGTH = 2048;

function hasUnsafeChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // C0 controls and space (stripped or re-interpreted by URL parsers), DEL, backslash.
    if (c <= 0x20 || c === 0x7f || c === 0x5c) return true;
  }
  return false;
}

export function safeNextPath(
  raw: string | null | undefined,
  fallback: string = DEFAULT_NEXT_PATH,
): string {
  if (!raw || raw.length > MAX_LENGTH) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || hasUnsafeChar(raw)) return fallback;
  let url: URL;
  try {
    url = new URL(raw, FAKE_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== FAKE_ORIGIN) return fallback;
  const path = `${url.pathname}${url.search}${url.hash}`;
  // Never bounce back onto the login form itself.
  if (path === "/login" || path.startsWith("/login?") || path.startsWith("/login#"))
    return fallback;
  return path;
}
