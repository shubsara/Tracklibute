import { notFound } from "next/navigation";

import { isDevAuthAllowed } from "@/server/auth/dev-provider";

export const dynamic = "force-dynamic";

/** DEVELOPMENT ONLY. 404s when dev auth is disabled. */
export default function DevLoginPage() {
  if (!isDevAuthAllowed()) notFound();

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Development sign-in</h1>
      <p className="text-sm text-neutral-500">
        Seeded users: alice@acme.test (OWNER), bob@acme.test (MEMBER), vera@acme.test (VIEWER) in{" "}
        <code>acme</code>; gina@globex.test (OWNER) in <code>globex</code>.
      </p>
      <form method="post" action="/api/dev/session" className="flex flex-col gap-3 text-sm">
        <input name="email" type="email" required placeholder="email" defaultValue="alice@acme.test" className="rounded border px-2 py-1" />
        <input name="organizationSlug" required placeholder="organization slug" defaultValue="acme" className="rounded border px-2 py-1" />
        <button type="submit" className="rounded border px-3 py-1">
          Sign in
        </button>
      </form>
    </section>
  );
}
