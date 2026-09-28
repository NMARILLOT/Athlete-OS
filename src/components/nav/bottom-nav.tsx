"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarDays, Dumbbell, Home, TrendingUp, UserRound } from "lucide-react";
import { cn } from "@/lib/cn";

const ITEMS = [
  { href: "/today", label: "Today", icon: Home },
  { href: "/calendar", label: "Calendar", icon: CalendarDays },
  { href: "/train", label: "Train", icon: Dumbbell },
  { href: "/progress", label: "Progress", icon: TrendingUp },
  { href: "/profile", label: "Profile", icon: UserRound },
] as const;

export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Navigation principale"
      className="pb-safe bg-bg/90 border-border fixed inset-x-0 bottom-0 z-40 border-t backdrop-blur"
    >
      <ul className="mx-auto flex max-w-lg items-stretch justify-between px-2">
        {ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-xl text-[11px] font-medium transition-colors",
                  active ? "text-accent" : "text-fg-subtle hover:text-fg-muted",
                )}
              >
                <Icon className="size-6" strokeWidth={active ? 2.4 : 1.8} aria-hidden />
                <span>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
