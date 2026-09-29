import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { requireUser } from "@/server/auth";
import { httpError } from "@/server/http";
import { errorFields, log } from "@/server/logging";
import { importFitFile, InvalidFitError } from "@/server/services/activity.service";
import { recompute } from "@/server/services/recommendation.service";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Upload cap (ARCHITECTURE §7: uploads go through multipart Route Handlers, not Server Actions). */
const MAX_BYTES = 25 * 1024 * 1024;

const tooLarge = () =>
  NextResponse.json({ error: "Fichier trop volumineux (25 Mo max)." }, { status: 413 });

/**
 * POST /api/import/fit — multipart field `file`, or a raw `application/octet-stream` body with
 * `?filename=`. Parses in-request, imports through the shared activity pipeline and recomputes
 * today's recommendation when training data changed.
 */
export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const user = await requireUser();
    const contentType = req.headers.get("content-type") ?? "";
    let bytes: Uint8Array;
    let filename: string;
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0)
        return NextResponse.json({ error: "Aucun fichier reçu." }, { status: 400 });
      if (file.size > MAX_BYTES) return tooLarge();
      bytes = new Uint8Array(await file.arrayBuffer());
      filename = file.name || "activity.fit";
    } else {
      const declared = Number(req.headers.get("content-length") ?? 0);
      if (declared > MAX_BYTES) return tooLarge();
      const buf = await req.arrayBuffer();
      if (buf.byteLength === 0)
        return NextResponse.json({ error: "Aucun fichier reçu." }, { status: 400 });
      if (buf.byteLength > MAX_BYTES) return tooLarge();
      bytes = new Uint8Array(buf);
      filename = new URL(req.url).searchParams.get("filename") ?? "activity.fit";
    }

    const db = await getDb();
    const result = await importFitFile(db, user, bytes, filename);
    if (!result.duplicate) {
      try {
        await recompute(db, user.id, { timezone: user.timezone });
      } catch (err) {
        log.warn("import.fit.recompute_failed", { userId: user.id, ...errorFields(err) });
      }
      revalidatePath("/today");
      revalidatePath("/calendar");
      revalidatePath("/activities");
    }
    log.info("import.fit.done", {
      userId: user.id,
      activityId: result.activityId,
      workoutId: result.workoutId ?? undefined,
      kind: result.duplicate ? "duplicate" : result.merged ? "merged" : "new",
      count: result.prs.length,
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json({
      activityId: result.activityId,
      workoutId: result.workoutId,
      duplicate: result.duplicate,
      warnings: result.warnings,
      prs: result.prs,
    });
  } catch (err) {
    if (err instanceof InvalidFitError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    // 401 / 403 (allow-list) / 422 … answer with their own status instead of a logged 500.
    const mapped = httpError(err);
    if (mapped) return NextResponse.json(mapped.body, { status: mapped.status });
    log.error("import.fit.failed", { ...errorFields(err), durationMs: Date.now() - startedAt });
    return NextResponse.json({ error: "Import impossible pour le moment." }, { status: 500 });
  }
}
