import { redirect } from "next/navigation";

import { getPageIdentity } from "@/server/auth/page-session";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const identity = await getPageIdentity();
  if (!identity) redirect("/login");
  if (identity.organizationId) redirect("/");
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Create your organization</h1>
      <form method="post" action="/api/organizations" className="flex flex-col gap-3 text-sm">
        <label className="flex flex-col gap-1">
          Organization name
          <input name="name" required minLength={2} maxLength={100} className="rounded border px-2 py-1" />
        </label>
        <button type="submit" className="self-start rounded border px-4 py-1">
          Create organization
        </button>
      </form>
    </section>
  );
}
