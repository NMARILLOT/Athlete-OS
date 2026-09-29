import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { getCurrentUser } from "@/server/auth";
import { getTodayView } from "@/server/services/today.service";
import { TodayScreen } from "@/components/today/today-screen";
import {
  acceptOptionAction,
  applyReschedulesAction,
  declareIntentAction,
  startOptionAction,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Today" };

export default async function TodayPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/today");
  const db = await getDb();
  const view = await getTodayView(db, user);
  if (!view.onboardingDone) redirect("/onboarding/1");
  return (
    <TodayScreen
      view={view}
      actions={{
        declareIntent: async (kind, intensity) => {
          "use server";
          return declareIntentAction(kind, intensity);
        },
        acceptOption: async (id, option) => {
          "use server";
          return acceptOptionAction(id, option);
        },
        startOption: async (option) => {
          "use server";
          return startOptionAction(option, view.recommendationId);
        },
        applyReschedule: async (plannedId) => {
          "use server";
          return applyReschedulesAction(plannedId);
        },
      }}
    />
  );
}
