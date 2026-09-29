"use client";

/**
 * Last-resort boundary: replaces the root layout when it fails itself. Global styles do not apply
 * here (Next renders its own document), hence the inline styles and explicit html/body.
 */
export default function GlobalError({
  error,
  retry,
  reset,
}: {
  error: Error & { digest?: string };
  retry?: () => void;
  reset: () => void;
}) {
  return (
    <html lang="fr">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          background: "#0b0d10",
          color: "#eef2f6",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
        }}
      >
        <div style={{ maxWidth: 420, width: "100%", textAlign: "center" }}>
          <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Un problème est survenu</h1>
          <p style={{ color: "#9aa5b3", marginTop: 8 }}>
            L&apos;application n&apos;a pas pu démarrer. Réessaie dans un instant.
          </p>
          <button
            type="button"
            onClick={() => (retry ?? reset)()}
            style={{
              marginTop: 20,
              height: 56,
              width: "100%",
              border: 0,
              borderRadius: 16,
              background: "#6ee7b7",
              color: "#06291c",
              fontSize: 18,
              fontWeight: 600,
            }}
          >
            Réessayer
          </button>
          {error.digest ? (
            <p style={{ color: "#6b7684", fontSize: 11, marginTop: 16, fontFamily: "monospace" }}>
              Réf. {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
