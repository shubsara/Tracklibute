import Link from "next/link";

import type { Recommendation } from "@/generated/prisma/client";
import { hasRole } from "@/domain/auth/auth-context";
import { requirePageAuth } from "@/server/auth/page-session";
import { listRecommendations } from "@/server/recommendations/recommendations.service";

export const dynamic = "force-dynamic";

const TABS: { label: string; status: Recommendation["status"] }[] = [
  { label: "Open", status: "OPEN" },
  { label: "Snoozed", status: "SNOOZED" },
  { label: "Accepted", status: "ACCEPTED" },
  { label: "Dismissed", status: "DISMISSED" },
  { label: "Resolved", status: "RESOLVED" },
];

function ActionForm({ id, action, label, extra }: { id: string; action: string; label: string; extra?: Record<string, string> }) {
  return (
    <form method="post" action={`/api/recommendations/${id}/${action}`}>
      <input type="hidden" name="returnTo" value="/recommendations" />
      {Object.entries(extra ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button type="submit" className="rounded border px-2 py-0.5 text-xs">
        {label}
      </button>
    </form>
  );
}

/** Recommendation inbox. Actions are internal only (nothing is written to HubSpot). */
export default async function RecommendationsPage({ searchParams }: { searchParams: Promise<{ status?: string; mine?: string }> }) {
  const auth = await requirePageAuth();
  const { status, mine } = await searchParams;
  const current = TABS.find((t) => t.status === status)?.status ?? "OPEN";
  const recs = await listRecommendations(auth, { status: current, mine: mine === "true" });
  const canAct = hasRole(auth, "MEMBER");
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Recommendations</h1>
      <nav className="flex flex-wrap gap-3 text-sm">
        {TABS.map((t) => (
          <Link key={t.status} href={`/recommendations?status=${t.status}${mine === "true" ? "&mine=true" : ""}`} className={t.status === current ? "font-semibold" : "underline"}>
            {t.label}
          </Link>
        ))}
        <Link href={`/recommendations?status=${current}${mine === "true" ? "" : "&mine=true"}`} className="underline">
          {mine === "true" ? "Everyone's" : "Mine"}
        </Link>
      </nav>
      {recs.length === 0 ? (
        <p className="text-sm text-neutral-500">Nothing here.</p>
      ) : (
        <ul className="divide-y text-sm">
          {recs.map((r) => (
            <li key={r.id} className="space-y-1 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-neutral-100 px-1.5 text-xs dark:bg-neutral-800">{r.severity.toLowerCase()}</span>
                {r.dealId ? (
                  <Link href={`/opportunities/${r.dealId}`} className="font-medium underline">
                    {r.title}
                  </Link>
                ) : (
                  <span className="font-medium">{r.title}</span>
                )}
              </div>
              <p className="text-neutral-600">{r.summary}</p>
              {r.snoozedUntil && r.status === "SNOOZED" && (
                <p className="text-xs text-neutral-500">Snoozed until {r.snoozedUntil.toLocaleString()}</p>
              )}
              {canAct && r.status !== "RESOLVED" && (
                <div className="flex gap-2">
                  {r.status !== "ACCEPTED" && <ActionForm id={r.id} action="accept" label="I'm on it" />}
                  <ActionForm id={r.id} action="snooze" label="Snooze 7 days" extra={{ days: "7" }} />
                  {r.status !== "DISMISSED" && <ActionForm id={r.id} action="dismiss" label="Dismiss" />}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
