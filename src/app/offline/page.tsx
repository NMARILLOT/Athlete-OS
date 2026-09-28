export const dynamic = "force-static";

export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-2xl font-semibold">Hors ligne</h1>
      <p className="text-fg-muted">
        Pas de connexion. Une séance musculation en cours continue de fonctionner ; le reste se
        synchronisera au retour du réseau.
      </p>
    </main>
  );
}
