import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { FitImportForm } from "@/components/activities/fit-import-form";
import { PageHeader } from "@/components/ui/page-header";

export const dynamic = "force-dynamic";
export const metadata = { title: "Importer un fichier FIT" };

export default async function ImportFitPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/activities/import");
  return (
    <section className="py-2">
      <PageHeader title="Importer un fichier FIT" closeHref="/activities" />
      <FitImportForm />
    </section>
  );
}
