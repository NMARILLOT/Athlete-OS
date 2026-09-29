import { BottomNav } from "@/components/nav/bottom-nav";
import { PlusPalette } from "@/components/nav/plus-palette";
import { InstallHint } from "@/components/pwa/install-hint";
import { SessionOwner } from "@/components/pwa/session-owner";
import { getCurrentUser } from "@/server/auth";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Cached per request: pages and actions share this lookup. Publishes the owner of the
  // device's strength session store (ARCHITECTURE §4.6); the proxy already gates unauthenticated
  // navigations, so a null user here only means "no owner to bind".
  const user = await getCurrentUser();
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col">
      <main className="pt-safe flex-1 px-4 pb-28">{children}</main>
      <PlusPalette />
      <InstallHint />
      <BottomNav />
      <SessionOwner userId={user?.id ?? null} />
    </div>
  );
}
