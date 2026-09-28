"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { supabaseBrowser } from "@/lib/supabase-browser";

/**
 * Email + password, or a 6-digit email OTP typed in-app — no magic links (they open in Safari's
 * separate storage silo on an installed iOS PWA, ARCHITECTURE §7). Sign-ups are disabled server-side.
 */
export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/today";
  const [mode, setMode] = useState<"password" | "otp" | "otp-verify">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const supabase = supabaseBrowser();

  if (!supabase) {
    return (
      <div className="bg-bg-elevated border-border rounded-2xl border p-4">
        <p className="font-medium">Mode local</p>
        <p className="text-fg-muted mt-1 text-sm">Supabase n&apos;est pas configuré : l&apos;application tourne en mode utilisateur unique.</p>
        <Button className="mt-4" full onClick={() => router.push(next)}>
          Entrer
        </Button>
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "password") {
        const { error } = await supabase!.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.replace(next);
        router.refresh();
      } else if (mode === "otp") {
        const { error } = await supabase!.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
        if (error) throw error;
        setMode("otp-verify");
      } else {
        const { error } = await supabase!.auth.verifyOtp({ email, token: code, type: "email" });
        if (error) throw error;
        router.replace(next);
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connexion impossible");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-fg-muted text-sm">Email</span>
        <input type="email" inputMode="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="bg-bg-elevated border-border focus:border-accent h-12 rounded-xl border px-4 text-base outline-none" />
      </label>
      {mode === "password" ? (
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted text-sm">Mot de passe</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="bg-bg-elevated border-border focus:border-accent h-12 rounded-xl border px-4 text-base outline-none" />
        </label>
      ) : mode === "otp-verify" ? (
        <label className="flex flex-col gap-1">
          <span className="text-fg-muted text-sm">Code reçu par email</span>
          <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" required value={code} onChange={(e) => setCode(e.target.value)} className="bg-bg-elevated border-border focus:border-accent h-12 rounded-xl border px-4 text-center text-2xl tracking-[0.4em] outline-none" />
        </label>
      ) : null}
      {error ? <p className="text-danger text-sm">{error}</p> : null}
      <Button type="submit" size="lg" full disabled={busy}>
        {busy ? "…" : mode === "password" ? "Se connecter" : mode === "otp" ? "Recevoir un code" : "Valider le code"}
      </Button>
      <button type="button" className="text-fg-muted mt-2 text-sm underline-offset-4 hover:underline" onClick={() => setMode(mode === "password" ? "otp" : "password")}>
        {mode === "password" ? "Recevoir un code par email à la place" : "Utiliser un mot de passe"}
      </button>
    </form>
  );
}
