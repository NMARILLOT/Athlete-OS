import { describe, expect, it } from "vitest";
import { isNextRedirect } from "@/lib/next-redirect";
import { errorMessage } from "@/components/log/fields";

/** Shape of the rejection Next hands to the client when a Server Action calls redirect(). */
function redirectRejection(href = "/today") {
  const err = new Error("NEXT_REDIRECT") as Error & { digest?: string };
  err.digest = `NEXT_REDIRECT;push;${href};307;`;
  return err;
}

describe("isNextRedirect", () => {
  it("recognises the NEXT_REDIRECT digest", () => {
    expect(isNextRedirect(redirectRejection())).toBe(true);
    expect(isNextRedirect({ digest: "NEXT_REDIRECT;replace;/login;307;" })).toBe(true);
  });

  it("ignores everything else", () => {
    expect(isNextRedirect(new Error("NEXT_REDIRECT"))).toBe(false); // message alone is not the signal
    expect(isNextRedirect({ digest: "NEXT_NOT_FOUND" })).toBe(false);
    expect(isNextRedirect(new Error("boom"))).toBe(false);
    expect(isNextRedirect(null)).toBe(false);
    expect(isNextRedirect("NEXT_REDIRECT")).toBe(false);
  });
});

describe("errorMessage (log forms)", () => {
  it("returns no message for a redirect, so a successful save does not flash an error", () => {
    expect(errorMessage(redirectRejection())).toBeNull();
  });

  it("keeps the short French messages for real failures", () => {
    expect(errorMessage(new Error("Invalid input"))).toBe(
      "Impossible d'enregistrer. Vérifie les valeurs et réessaie.",
    );
    expect(errorMessage("x")).toBe("Impossible d'enregistrer. Réessaie.");
    expect(errorMessage(undefined)).toBe("Impossible d'enregistrer. Réessaie.");
  });
});
