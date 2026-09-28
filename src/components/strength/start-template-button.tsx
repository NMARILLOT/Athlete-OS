"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { startTemplateAction } from "@/app/(app)/today/actions";

export function StartTemplateButton({ templateId }: { templateId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const { href } = await startTemplateAction(templateId);
          router.push(href);
        })
      }
    >
      {pending ? "…" : "Start"}
    </Button>
  );
}
