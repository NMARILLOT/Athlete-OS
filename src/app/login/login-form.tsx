"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { safeNextPath } from "@/lib/safe-next-path";
import { supabaseBrowser } from "@/lib/supabase-browser";

/**
 * Email + password, or a 6-digit email OTP typed in-app — no magic links (they open in Safari's
 * separate storage silo on an installed iOS PWA, ARCHITECTURE §7). Sign-ups are disabled server-side.
 * `?next=` is only honoured as a same-origin path (open-redirect guard). `?reason=forbidden` is set
 * by the proxy after it signed out an account outside ALLOWED_EMAILS, so the refusal is explained.
 */
export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNextPath(params.get("next"));
  const forbidden = params.get("reason") === "forbidden";
  const [mode, setMode] = useState<"password" | "otp" | "otp-verify">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const supabase = supabaseBrowser();

  if (!supabase) {
    return (
      <div className="rounded-2xl border border-border bg-bg-elevated p-4">
        <p className="font-medium">Mode local</p>
        <p className="mt-1 text-sm text-fg-muted">
          Supabase n&apos;est pas configuré : l&apos;application tourne en mode utilisateur unique.
        </p>
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
        const { error } = await supabase!.auth.signInWithOtp({
          email,
          options: { shouldCreateUser: false },
        });
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
      {forbidden ? (
        <p role="alert" className="rounded-xl border border-border bg-bg-elevated p-3 text-sm">
          <span className="font-medium">Ce compte n&apos;est pas autorisé.</span>{" "}
          <span className="text-fg-muted">
            La session a été fermée : connecte-toi avec un compte autorisé.
          </span>
        </p>
      ) : null}
      <label className="flex flex-col gap-1">
        <span className="text-sm text-fg-muted">Email</span>
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="h-12 rounded-xl border border-border bg-bg-elevated px-4 text-base outline-none focus:border-accent"
        />
      </label>
      {mode === "password" ? (
        <label className="flex flex-col gap-1">
          <span className="text-sm text-fg-muted">Mot de passe</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-12 rounded-xl border border-border bg-bg-elevated px-4 text-base outline-none focus:border-accent"
          />
        </label>
      ) : mode === "otp-verify" ? (
        <label className="flex flex-col gap-1">
          <span className="text-sm text-fg-muted">Code reçu par email</span>
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="h-12 rounded-xl border border-border bg-bg-elevated px-4 text-center text-2xl tracking-[0.4em] outline-none focus:border-accent"
          />
        </label>
      ) : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <Button type="submit" size="lg" full disabled={busy}>
        {busy
          ? "…"
          : mode === "password"
            ? "Se connecter"
            : mode === "otp"
              ? "Recevoir un code"
              : "Valider le code"}
      </Button>
      <button
        type="button"
        className="mt-2 text-sm text-fg-muted underline-offset-4 hover:underline"
        onClick={() => setMode(mode === "password" ? "otp" : "password")}
      >
        {mode === "password" ? "Recevoir un code par email à la place" : "Utiliser un mot de passe"}
      </button>
    </form>
  );
}
