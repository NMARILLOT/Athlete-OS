import { Suspense } from "react";
import { LoginForm } from "./login-form";

export const metadata = { title: "Connexion" };

export default function LoginPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-10">
      <div className="mb-8">
        <div className="bg-accent mb-4 size-12 rounded-2xl" aria-hidden />
        <h1 className="text-3xl font-semibold tracking-tight">Athlete OS</h1>
        <p className="text-fg-muted mt-1">Ton système d&apos;entraînement adaptatif.</p>
      </div>
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
