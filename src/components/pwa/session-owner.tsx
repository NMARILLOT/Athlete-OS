"use client";

import { useEffect } from "react";
import { bindStrengthSessionOwner } from "@/stores/strength-session";

/**
 * Mounted once from the (app) layout: publishes the signed-in athlete to the strength session
 * store so the persisted session/outbox is bound to its owner (ARCHITECTURE §4.6). The root-mounted
 * flusher then never posts another account's queue, and a snapshot left by a previous account on
 * this device is dropped instead of surfacing in the shell. Renders nothing.
 */
export function SessionOwner({ userId }: { userId: string | null }) {
  useEffect(() => {
    void bindStrengthSessionOwner(userId);
    return () => {
      void bindStrengthSessionOwner(null);
    };
  }, [userId]);
  return null;
}
