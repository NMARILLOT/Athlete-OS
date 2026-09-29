/**
 * When a Server Action calls `redirect()`, Next rejects the action promise on the client with an
 * error whose `digest` starts with "NEXT_REDIRECT" — and still performs the navigation. Client code
 * that catches action errors to show an inline message must not treat that rejection as a failure:
 * either return no message for it, or rethrow it so Next's RedirectBoundary handles it.
 */
export function isNextRedirect(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const digest = (err as { digest?: unknown }).digest;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}
