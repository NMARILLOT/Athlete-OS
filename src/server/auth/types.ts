export interface CurrentUser {
  id: string;
  email: string;
  timezone: string;
  displayName: string | null;
  onboardingCompletedAt: string | null;
}

/** Fixed uuid for the single local-mode user. Never a valid production id (documented, ADR-021). */
export const LOCAL_USER_ID = "00000000-0000-4000-8000-00000000a05e";
