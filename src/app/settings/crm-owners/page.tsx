import { hasRole } from "@/domain/auth/auth-context";
import { requirePageAuth } from "@/server/auth/page-session";
import { listCrmOwners } from "@/server/crm/owner-mapping.service";

export const dynamic = "force-dynamic";

/** HubSpot owner → teammate mapping (ADMIN edits; everyone can see). */
export default async function CrmOwnersPage() {
  const auth = await requirePageAuth();
  const { owners, members } = await listCrmOwners(auth);
  const canEdit = hasRole(auth, "ADMIN");
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">HubSpot owners</h1>
      <p className="text-xs text-neutral-500">
        Owners are matched to teammates by email automatically. A manual mapping is never overwritten by sync.
      </p>
      {owners.length === 0 ? (
        <p className="text-sm text-neutral-500">No HubSpot owners synced yet.</p>
      ) : (
        <ul className="divide-y text-sm">
          {owners.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="min-w-48">
                {o.name ?? o.email ?? o.externalId}
                {o.archived && <span className="text-xs text-neutral-500"> (deactivated)</span>}
                {o.email && o.name && <span className="block text-xs text-neutral-500">{o.email}</span>}
              </span>
              {canEdit ? (
                <form method="post" action={`/api/crm/owners/${o.id}/mapping`} className="flex items-center gap-2">
                  <select name="userId" defaultValue={o.mapping?.userId ?? ""} className="rounded border px-2 py-1 text-sm">
                    <option value="">— not mapped —</option>
                    {members.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.name ? `${m.name} (${m.email})` : m.email}
                      </option>
                    ))}
                  </select>
                  <button type="submit" className="rounded border px-2 py-1 text-xs">
                    Save
                  </button>
                </form>
              ) : (
                <span className="text-neutral-600">{o.mapping ? o.mapping.userName ?? o.mapping.userEmail : "not mapped"}</span>
              )}
              {o.mapping && <span className="text-xs text-neutral-500">{o.mapping.source === "MANUAL" ? "manual" : "auto"}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
