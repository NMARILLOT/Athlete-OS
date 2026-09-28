import { BottomNav } from "@/components/nav/bottom-nav";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col">
      <main className="pt-safe flex-1 px-4 pb-28">{children}</main>
      <BottomNav />
    </div>
  );
}
