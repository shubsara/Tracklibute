import { notFound } from "next/navigation";

import { HealthBadge } from "@/app/_components/health-badge";
import { LimitedSignalNote } from "@/app/_components/limited-signal-note";
import { NotFoundError } from "@/lib/errors";
import { requirePageAuth } from "@/server/auth/page-session";
import { type DealDetailDTO, getDeal } from "@/server/crm/crm.service";

import { DealRecommendations } from "./deal-recommendations";

export const dynamic = "force-dynamic";

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

/** One deal: why it is (un)healthy, and a metadata-only activity timeline (no email content). */
export default async function DealPage({ params }: { params: Promise<{ dealId: string }> }) {
  const auth = await requirePageAuth();
  const { dealId } = await params;
  let deal: DealDetailDTO;
  try {
    deal = await getDeal(auth, dealId);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const ev = deal.evidence;
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{deal.name}</h1>
        <div className="flex items-center gap-2 text-sm">
          <HealthBadge state={deal.health?.state ?? null} />
          <span className="text-neutral-500">
            {[deal.pipeline, deal.stage, deal.owner?.name ?? deal.owner?.email].filter(Boolean).join(" · ")}
          </span>
        </div>
      </div>

      <DealRecommendations active={deal.recommendation} resolved={deal.resolvedRecommendations} />
      {deal.health?.limitedSignal && <LimitedSignalNote />}

      <dl className="grid grid-cols-[11rem_1fr] gap-y-1 text-sm">
        <dt className="text-neutral-500">Close date</dt>
        <dd>{fmt(deal.closeDate)}</dd>
        <dt className="text-neutral-500">Next activity (CRM)</dt>
        <dd>{fmt(deal.nextActivityAt)}</dd>
        <dt className="text-neutral-500">Last CRM activity</dt>
        <dd>{fmt(deal.crmLastActivityAt)}</dd>
        <dt className="text-neutral-500">Last email in / out</dt>
        <dd>
          {fmt(ev?.lastInboundAt ?? null)} / {fmt(ev?.lastOutboundAt ?? null)}
        </dd>
        <dt className="text-neutral-500">Evaluated</dt>
        <dd>{fmt(deal.health?.evaluatedAt ?? null)}</dd>
      </dl>

      <div className="space-y-1 text-sm">
        <h2 className="font-medium">Contacts</h2>
        {deal.contacts.length === 0 && deal.companies.length === 0 ? (
          <p className="text-neutral-500">No associated contacts or companies.</p>
        ) : (
          <ul className="text-neutral-700">
            {deal.contacts.map((c, i) => (
              <li key={`c${i}`}>{[c.name, c.email].filter(Boolean).join(" · ")}</li>
            ))}
            {deal.companies.map((c, i) => (
              <li key={`co${i}`}>{[c.name, c.domain].filter(Boolean).join(" · ")}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1 text-sm">
        <h2 className="font-medium">Email activity</h2>
        <p className="text-xs text-neutral-500">Dates and directions only. Email content stays private to each mailbox owner.</p>
        {deal.timeline.length === 0 ? (
          <p className="text-neutral-500">No matched email activity.</p>
        ) : (
          <ul className="divide-y">
            {deal.timeline.map((t, i) => (
              <li key={i} className="py-1">
                {fmt(t.occurredAt)} · {t.direction === "INBOUND" ? `from ${t.counterpartEmail}` : `to ${t.counterpartEmail}`}
                {t.teammate ? ` · ${t.teammate}` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
