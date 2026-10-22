import Link from "next/link";

import type { DealRecommendationDTO } from "@/server/crm/crm.service";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

/**
 * A deal's recommendations. Only an unresolved recommendation is shown as an
 * issue; resolved ones appear in a separate, subdued "Resolved" section so an
 * old message (e.g. "has no next step scheduled") is never read as current.
 * Actions (snooze / dismiss / "I'm on it") stay on the Recommendations inbox.
 */
export function DealRecommendations({ active, resolved }: { active: DealRecommendationDTO | null; resolved: DealRecommendationDTO[] }) {
  return (
    <>
      {active && (
        <div className="rounded border p-3 text-sm" data-testid="active-recommendation">
          <p className="font-medium">{active.title}</p>
          <p className="text-neutral-600">{active.summary}</p>
          <p className="text-xs text-neutral-500">
            Recommendation status: {active.status.toLowerCase()} ·{" "}
            <Link href={`/recommendations?status=${active.status}`} className="underline">
              act on it
            </Link>
          </p>
        </div>
      )}
      {resolved.length > 0 && (
        <details className="text-sm text-neutral-500" data-testid="resolved-recommendations">
          <summary className="cursor-pointer">Resolved ({resolved.length})</summary>
          <ul className="mt-1 space-y-1 border-l pl-3">
            {resolved.map((r) => (
              <li key={r.id}>
                <span className="mr-1 rounded bg-neutral-100 px-1 text-xs dark:bg-neutral-800">Resolved</span>
                <span className="line-through decoration-neutral-400">{r.title}</span>
                <span className="text-xs"> · resolved {fmt(r.resolvedAt)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
