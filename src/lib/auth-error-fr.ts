/**
 * Supabase Auth errors → short French messages for the login screen. Supabase returns English
 * text ("Invalid login credentials", "Failed to fetch"…); the `code` field is used when present
 * (auth-js ≥ 2.6x), the message otherwise. Unknown errors keep their original text after a prefix.
 */
const BY_CODE: Record<string, string> = {
  invalid_credentials: "Email ou mot de passe incorrect.",
  email_not_confirmed:
    "Email non confirmé : dans Supabase, confirme l'utilisateur (option « Auto Confirm User »).",
  user_not_found: "Aucun compte pour cet email.",
  otp_expired: "Code expiré ou invalide : demande un nouveau code.",
  otp_disabled: "La connexion par code est désactivée dans Supabase : utilise ton mot de passe.",
  signup_disabled: "Aucun compte pour cet email (les inscriptions sont fermées).",
  over_email_send_rate_limit:
    "Trop d'emails envoyés : attends quelques minutes avant de redemander un code.",
  over_request_rate_limit: "Trop de tentatives : réessaie dans quelques minutes.",
  user_banned: "Ce compte est bloqué.",
};

const BY_MESSAGE: Array<[RegExp, string]> = [
  [/invalid login credentials/i, BY_CODE.invalid_credentials as string],
  [/email not confirmed/i, BY_CODE.email_not_confirmed as string],
  [/signups? not allowed/i, BY_CODE.signup_disabled as string],
  [/token has expired|invalid (otp|token)|otp.*(expired|invalid)/i, BY_CODE.otp_expired as string],
  [/rate limit|too many requests/i, BY_CODE.over_request_rate_limit as string],
  [
    /failed to fetch|network|load failed|fetch failed/i,
    "Impossible de joindre le service de connexion : vérifie ta connexion internet, puis la configuration Supabase de l'app.",
  ],
];

export function authErrorFr(error: unknown): string {
  if (!(error instanceof Error)) return "Connexion impossible. Réessaie.";
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === "string" && BY_CODE[code]) return BY_CODE[code] as string;
  for (const [pattern, message] of BY_MESSAGE) if (pattern.test(error.message)) return message;
  return error.message
    ? `Connexion impossible : ${error.message}`
    : "Connexion impossible. Réessaie.";
}
