import Link from "next/link";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getCurrentUser } from "@/server/auth";
import { listInbox } from "@/server/services/inbox.service";
import { Chip } from "@/components/ui/chip";
import { Empty } from "@/components/ui/empty";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";
export const metadata = { title: "WOD Inbox" };

const STATUS_FR: Record<string, string> = {
  new: "nouveau",
  parsed: "analysé",
  needs_review: "à vérifier",
  confirmed: "confirmé",
  discarded: "ignoré",
};

export default async function InboxPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/inbox");
  const db = await getDb();
  const items = await listInbox(db, user.id);
  return (
    <section className="py-2">
      <PageHeader
        title="WOD Inbox"
        closeHref="/train"
        action={
          <Link href="/inbox/new" className="text-sm font-semibold text-accent">
            + WOD
          </Link>
        }
      />
      {items.length === 0 ? (
        <Empty title="Aucun WOD">
          Colle le WOD du jour : l&apos;app le structure et l&apos;intègre à ta programmation.
          <div className="mt-3">
            <Link href="/inbox/new">
              <Button>Ajouter un WOD</Button>
            </Link>
          </div>
        </Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((it) => (
            <li key={it.id}>
              <Link
                href={`/inbox/${it.id}`}
                className="block rounded-2xl border border-border bg-bg-elevated p-3"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    {it.normalizedWod?.title ??
                      (it.rawText ?? "").split("\n")[0]?.slice(0, 40) ??
                      "WOD"}
                  </span>
                  <Chip
                    tone={
                      it.status === "confirmed"
                        ? "accent"
                        : it.status === "needs_review"
                          ? "warn"
                          : "neutral"
                    }
                  >
                    {STATUS_FR[it.status] ?? it.status}
                  </Chip>
                </div>
                <p className="mt-1 line-clamp-2 text-xs whitespace-pre-line text-fg-muted">
                  {it.rawText}
                </p>
                {it.scheduledFor ? (
                  <p className="mt-1 text-xs text-fg-subtle">
                    {it.scheduledFor}
                    {it.startLocal ? ` · ${it.startLocal.slice(0, 5)}` : ""}
                  </p>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
