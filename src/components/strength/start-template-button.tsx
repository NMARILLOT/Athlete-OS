"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { startTemplateAction } from "@/app/(app)/today/actions";
import { ErrorNote } from "@/components/log/fields";
import { isNextRedirect } from "@/lib/next-redirect";

export function StartTemplateButton({ templateId }: { templateId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            try {
              const { href } = await startTemplateAction(templateId);
              router.push(href);
            } catch (err) {
              if (isNextRedirect(err)) throw err;
              setError("Impossible de démarrer. Réessaie.");
            }
          })
        }
      >
        {pending ? "…" : "Start"}
      </Button>
      <ErrorNote message={error} />
    </div>
  );
}
