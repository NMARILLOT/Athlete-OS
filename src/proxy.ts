import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { safeNextPath } from "@/lib/safe-next-path";
import { parseEmailList } from "@/server/env-schema";

/**
 * Next 16 proxy (formerly middleware): refreshes the Supabase session cookie and redirects
 * unauthenticated page navigations to /login (ARCHITECTURE §7). In AUTH_MODE=local nothing is enforced.
 * Server Actions and Route Handlers re-authenticate themselves with requireUser(); this is only the UX gate.
 *
 * An authenticated account outside ALLOWED_EMAILS is signed out here and sent to
 * `/login?reason=forbidden`: every (app) page would otherwise throw ForbiddenError, including the
 * one carrying the sign-out button, and a session with no exit is a dead end. getCurrentUser()
 * keeps the authoritative check; this only makes the refusal navigable.
 */
export async function proxy(request: NextRequest) {
  const authMode = process.env.AUTH_MODE ?? "supabase";
  if (authMode === "local") return NextResponse.next();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookies) => {
        for (const { name, value } of cookies) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookies) response.cookies.set(name, value, options);
      },
    },
  });
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { pathname: path, search, origin } = request.nextUrl;
  const isApi = path.startsWith("/api/");
  const isPublic = path === "/login" || path === "/offline" || isApi;

  if (user && !isApi && !isAllowedEmail(user.email)) {
    // Clears the session cookies through setAll (so `response` now carries them), then explains on
    // the login form. Route Handlers keep answering 403 themselves (their fetches must not be
    // redirected to HTML). Already on the explained login form → render it, never loop.
    await supabase.auth.signOut();
    if (path === "/login" && request.nextUrl.searchParams.get("reason") === "forbidden")
      return response;
    return withCookiesFrom(
      NextResponse.redirect(new URL("/login?reason=forbidden", origin)),
      response,
    );
  }
  if (!user && !isPublic) {
    const login = new URL("/login", origin);
    login.searchParams.set("next", `${path}${search}`);
    return NextResponse.redirect(login);
  }
  if (user && path === "/login") {
    // Resolved as a relative URL (not assigned to `pathname`, which would percent-encode `?`/`#`):
    // safeNextPath only ever returns a same-origin absolute path, query and hash included.
    return NextResponse.redirect(
      new URL(safeNextPath(request.nextUrl.searchParams.get("next")), origin),
    );
  }
  return response;
}

/** Empty allow-list = every account of the project (dev); production refuses to boot that way (env.ts). */
function isAllowedEmail(email: string | undefined): boolean {
  const allow = parseEmailList(process.env.ALLOWED_EMAILS);
  if (allow.length === 0) return true;
  return email !== undefined && allow.includes(email.toLowerCase());
}

/** Carry the Set-Cookie headers written through setAll onto a redirect response. */
function withCookiesFrom(target: NextResponse, source: NextResponse): NextResponse {
  for (const cookie of source.cookies.getAll()) target.cookies.set(cookie);
  return target;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|icons/|sw\\.js|manifest\\.webmanifest|favicon\\.ico|offline|api/cron/|api/health).*)",
  ],
};
