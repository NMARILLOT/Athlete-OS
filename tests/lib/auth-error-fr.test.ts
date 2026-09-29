import { describe, expect, it } from "vitest";
import { authErrorFr } from "@/lib/auth-error-fr";

function authError(message: string, code?: string): Error {
  const e = new Error(message) as Error & { code?: string };
  if (code) e.code = code;
  return e;
}

describe("authErrorFr", () => {
  it("maps Supabase codes first", () => {
    expect(authErrorFr(authError("Invalid login credentials", "invalid_credentials"))).toBe(
      "Email ou mot de passe incorrect.",
    );
    expect(authErrorFr(authError("whatever", "otp_expired"))).toMatch(/Code expiré/);
  });

  it("falls back on the English message", () => {
    expect(authErrorFr(authError("Invalid login credentials"))).toBe(
      "Email ou mot de passe incorrect.",
    );
    expect(authErrorFr(authError("Signups not allowed for otp"))).toMatch(/Aucun compte/);
    expect(authErrorFr(new TypeError("Failed to fetch"))).toMatch(/Impossible de joindre/);
    expect(authErrorFr(authError("Email rate limit exceeded"))).toMatch(/Trop/);
  });

  it("keeps unknown messages visible and handles non-errors", () => {
    expect(authErrorFr(authError("Something odd"))).toBe("Connexion impossible : Something odd");
    expect(authErrorFr("nope")).toBe("Connexion impossible. Réessaie.");
  });
});
