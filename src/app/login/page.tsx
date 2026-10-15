import Link from "next/link";
import { redirect } from "next/navigation";

import { getPageIdentity } from "@/server/auth/page-session";
import { isDevAuthAllowed } from "@/server/auth/dev-provider";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  invalid_state: "Your sign-in session expired. Please try again.",
  consent_denied: "Google sign-in was cancelled.",
  sign_in_failed: "We couldn't sign you in with Google. Please try again.",
  session_required: "Please sign in to continue.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getPageIdentity()) redirect("/");
  const { error } = await searchParams;
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Sign in to Tracklibute</h1>
      {error && <p className="text-sm text-red-600">{ERRORS[error] ?? "Sign-in failed."}</p>}
      <a href="/api/auth/google/login" className="inline-block rounded border px-4 py-2">
        Sign in with Google
      </a>
      <p className="text-xs text-neutral-500">Signing in does not give Tracklibute access to your Gmail. You connect Gmail separately.</p>
      {isDevAuthAllowed() && (
        <p className="text-xs">
          <Link className="underline" href="/dev/login">
            Development sign-in
          </Link>
        </p>
      )}
    </section>
  );
}
