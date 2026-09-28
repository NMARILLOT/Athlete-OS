import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getCurrentUser } from "@/server/auth";
import { getInboxItem } from "@/server/services/inbox.service";
import { PageHeader } from "@/components/ui/page-header";
import { WodReview } from "@/components/inbox/wod-review";
import { localDate } from "@/server/time";

export const dynamic = "force-dynamic";
export const metadata = { title: "WOD" };

export default async function InboxItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/inbox/${id}`);
  const db = await getDb();
  const item = await getInboxItem(db, user.id, id);
  if (!item) notFound();
  return (
    <section className="py-2">
      <PageHeader title={item.normalizedWod?.title ?? "WOD"} closeHref="/inbox" />
      <WodReview item={item} today={localDate(new Date(), user.timezone)} />
    </section>
  );
}
