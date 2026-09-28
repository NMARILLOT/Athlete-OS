"use client";

import { createBrowserClient } from "@supabase/ssr";

/** Browser Supabase client — Auth only (email + password / OTP, ADR-021). */
export function supabaseBrowser() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  return createBrowserClient(url, anon);
}
