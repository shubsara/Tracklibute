import Link from "next/link";

import { HealthBadge, REASON_LABEL } from "@/app/_components/health-badge";
import { LimitedSignalNote } from "@/app/_components/limited-signal-note";
import { requirePageAuth } from "@/server/auth/page-session";
import { listDeals } from "@/server/crm/crm.service";

export const dynamic = "force-dynamic";

const FILTERS = [
  { label: "All open", q: "" },
  { label: "At risk", q: "state=AT_RISK" },
  { label: "Needs attention", q: "state=NEEDS_ATTENTION" },
  { label: "Mine", q: "mine=true" },
];

/** Open HubSpot deals with their deterministic Opportunity Health. */
export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<{ state?: string; mine?: string }> }) {
  const auth = await requirePageAuth();
  const { state, mine } = await searchParams;
  const deals = await listDeals(auth, { state: state || undefined, mine: mine === "true" });
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Opportunities</h1>
      <nav className="flex flex-wrap gap-3 text-sm">
        {FILTERS.map((f) => (
          <Link key={f.label} href={`/opportunities${f.q ? `?${f.q}` : ""}`} className="underline">
            {f.label}
          </Link>
        ))}
      </nav>
      {deals.length === 0 ? (
        <p className="text-sm text-neutral-500">No open deals. Connect HubSpot in Integrations, then sync.</p>
      ) : (
        <ul className="divide-y text-sm">
          {deals.map((d) => (
            <li key={d.id} className="space-y-1 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <HealthBadge state={d.health?.state ?? null} />
                <Link href={`/opportunities/${d.id}`} className="font-medium underline">
                  {d.name}
                </Link>
                {d.health?.limitedSignal && <LimitedSignalNote compact />}
              </div>
              <div className="text-neutral-500">
                {[d.stage, d.amount ? `${d.amount} ${d.currency ?? ""}`.trim() : null, d.owner?.name ?? d.owner?.email ?? "No owner",
                  d.closeDate ? `closes ${new Date(d.closeDate).toLocaleDateString()}` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
              {d.health && d.health.reasons.length > 0 && (
                <div className="text-xs text-neutral-600">{d.health.reasons.map((r) => REASON_LABEL[r.code] ?? r.code).join(" · ")}</div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
