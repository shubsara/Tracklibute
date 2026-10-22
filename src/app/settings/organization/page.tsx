import { hasRole } from "@/domain/auth/auth-context";
import { requirePageAuth } from "@/server/auth/page-session";
import { getInternalEmailDomains } from "@/server/email/email-activity.service";

export const dynamic = "force-dynamic";

/** Internal email domains: mail with these addresses is internal, never deal activity. */
export default async function OrganizationSettingsPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const auth = await requirePageAuth();
  const [domains, { saved }] = await Promise.all([getInternalEmailDomains(auth), searchParams]);
  const canEdit = hasRole(auth, "ADMIN");
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Organization</h1>
      {saved && <p className="text-sm text-neutral-600">Saved. Mailboxes re-derive their activity on their next sync.</p>}
      <div className="space-y-2 rounded border p-4 text-sm">
        <h2 className="font-medium">Internal email domains</h2>
        <p className="text-xs text-neutral-500">
          Each mailbox&apos;s own company domain and all teammates&apos; addresses are always internal. Add other domains your
          team uses. Public providers (gmail.com, outlook.com, …) cannot be added.
        </p>
        {canEdit ? (
          <form method="post" action="/api/organizations/email-domains" className="space-y-2">
            <textarea name="domains" defaultValue={domains.join("\n")} rows={4} className="w-full rounded border p-2 font-mono text-xs" />
            <button type="submit" className="rounded border px-3 py-1 text-sm">
              Save
            </button>
          </form>
        ) : (
          <p>{domains.length ? domains.join(", ") : "None configured."}</p>
        )}
      </div>
    </section>
  );
}
