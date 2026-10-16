import "server-only";

import { z } from "zod";

import type { AuthContext } from "@/domain/auth/auth-context";
import { domainMatches, isPublicEmailDomain } from "@/domain/email/activity";
import type { HealthState } from "@/domain/opportunity-health/detector";
import type { OpportunityHealthEvidence } from "@/domain/opportunity-health/evidence";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { withOrgScope } from "@/server/db/org-scope";
import { myDealIds } from "@/server/recommendations/recommendations.service";

/**
 * Read models over the CRM mirror for the UI / API. Organization-readable.
 * The deal timeline is built ONLY from content-free EmailActivity (date,
 * direction, counterpart address, teammate) — never from owner-private mail.
 */
export interface DealListItemDTO {
  id: string;
  externalId: string;
  name: string;
  amount: string | null;
  currency: string | null;
  stage: string | null;
  closeDate: string | null;
  owner: { name: string | null; email: string | null; userId: string | null } | null;
  health: { state: HealthState; reasons: OpportunityHealthEvidence["reasons"]; limitedSignal: boolean; evaluatedAt: string } | null;
}

export interface DealDetailDTO extends DealListItemDTO {
  pipeline: string | null;
  nextActivityAt: string | null;
  crmLastActivityAt: string | null;
  contacts: { name: string | null; email: string | null }[];
  companies: { name: string | null; domain: string | null }[];
  evidence: OpportunityHealthEvidence | null;
  recommendation: { id: string; status: string; title: string; summary: string; severity: string } | null;
  timeline: { occurredAt: string; direction: "INBOUND" | "OUTBOUND"; counterpartEmail: string; teammate: string | null }[];
}

const STATES = ["HEALTHY", "NEEDS_ATTENTION", "AT_RISK"] as const;
const RANK: Record<HealthState, number> = { AT_RISK: 0, NEEDS_ATTENTION: 1, HEALTHY: 2 };
const personName = (p: { firstName: string | null; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(" ") || null;

async function hubspotIntegrationId(tx: Parameters<Parameters<typeof withOrgScope>[1]>[0], auth: AuthContext) {
  const row = await tx.integration.findFirst({
    where: { organizationId: auth.organizationId, provider: "HUBSPOT", ownerUserId: null },
    select: { id: true },
  });
  return row?.id ?? null;
}

export async function listDeals(auth: AuthContext, opts: { state?: string; mine?: boolean } = {}): Promise<DealListItemDTO[]> {
  if (opts.state && !(STATES as readonly string[]).includes(opts.state)) throw new ValidationError("Unknown health state");
  return withOrgScope(auth, async (tx) => {
    const integrationId = await hubspotIntegrationId(tx, auth);
    if (!integrationId) return [];
    const mine = opts.mine ? await myDealIds(tx, auth) : null;
    const [deals, owners, stages] = await Promise.all([
      tx.crmDeal.findMany({
        where: {
          organizationId: auth.organizationId,
          integrationId,
          isClosed: false,
          archivedAt: null,
          ...(mine ? { id: { in: mine } } : {}),
          ...(opts.state ? { health: { state: opts.state as HealthState } } : {}),
        },
        include: { health: true },
        take: 500,
        orderBy: { closeDate: { sort: "asc", nulls: "last" } },
      }),
      tx.crmOwner.findMany({ where: { organizationId: auth.organizationId, integrationId }, include: { mapping: { select: { userId: true } } } }),
      tx.crmPipelineStage.findMany({ where: { organizationId: auth.organizationId, integrationId } }),
    ]);
    const ownerBy = new Map(owners.map((o) => [o.externalId, o]));
    const stageBy = new Map(stages.map((s) => [`${s.pipelineExternalId}/${s.externalId}`, s]));
    const items = deals.map((d): DealListItemDTO => {
      const owner = d.ownerExternalId ? ownerBy.get(d.ownerExternalId) : undefined;
      const ev = d.health?.reasons as OpportunityHealthEvidence | undefined;
      return {
        id: d.id,
        externalId: d.externalId,
        name: d.name,
        amount: d.amount?.toFixed(2) ?? null,
        currency: d.currency,
        stage: stageBy.get(`${d.pipelineExternalId}/${d.stageExternalId}`)?.label ?? d.stageExternalId,
        closeDate: d.closeDate?.toISOString() ?? null,
        owner: owner ? { name: personName(owner), email: owner.email, userId: owner.mapping?.userId ?? null } : null,
        health: d.health && ev
          ? { state: d.health.state, reasons: ev.reasons, limitedSignal: ev.emailCoverage.limitedSignal, evaluatedAt: d.health.evaluatedAt.toISOString() }
          : null,
      };
    });
    return items.sort((a, b) => RANK[a.health?.state ?? "HEALTHY"] - RANK[b.health?.state ?? "HEALTHY"]);
  });
}

export async function getDeal(auth: AuthContext, id: string): Promise<DealDetailDTO> {
  if (!z.uuid().safeParse(id).success) throw new NotFoundError("Deal not found");
  return withOrgScope(auth, async (tx) => {
    const d = await tx.crmDeal.findFirst({
      where: { id, organizationId: auth.organizationId },
      include: {
        health: true,
        contacts: { include: { contact: true } },
        companies: { include: { company: true } },
        recommendations: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    if (!d) throw new NotFoundError("Deal not found");
    const [owner, stage] = await Promise.all([
      d.ownerExternalId
        ? tx.crmOwner.findFirst({
            where: { organizationId: auth.organizationId, integrationId: d.integrationId, externalId: d.ownerExternalId },
            include: { mapping: { select: { userId: true } } },
          })
        : null,
      d.stageExternalId
        ? tx.crmPipelineStage.findFirst({
            where: { organizationId: auth.organizationId, integrationId: d.integrationId, pipelineExternalId: d.pipelineExternalId ?? "", externalId: d.stageExternalId },
          })
        : null,
    ]);

    const emails = d.contacts.flatMap((c) => (c.contact.email ? [c.contact.email] : []));
    const domains = d.companies.flatMap((c) => (c.company.domain && !isPublicEmailDomain(c.company.domain) ? [c.company.domain] : []));
    const activity = emails.length || domains.length
      ? await tx.emailActivity.findMany({
          where: {
            organizationId: auth.organizationId,
            OR: [
              ...(emails.length ? [{ counterpartEmail: { in: emails } }] : []),
              ...domains.flatMap((dom) => [{ counterpartDomain: dom }, { counterpartDomain: { endsWith: `.${dom}` } }]),
            ],
          },
          select: { occurredAt: true, direction: true, counterpartEmail: true, counterpartDomain: true, mailboxUserId: true },
          orderBy: { occurredAt: "desc" },
          take: 50,
        })
      : [];
    const teammateIds = [...new Set(activity.map((a) => a.mailboxUserId))];
    const teammates = teammateIds.length
      ? await tx.user.findMany({ where: { id: { in: teammateIds } }, select: { id: true, name: true, email: true } })
      : [];
    const teammateBy = new Map(teammates.map((t) => [t.id, t.name ?? t.email]));
    const ev = (d.health?.reasons as OpportunityHealthEvidence | undefined) ?? null;
    const rec = d.recommendations[0];

    return {
      id: d.id,
      externalId: d.externalId,
      name: d.name,
      amount: d.amount?.toFixed(2) ?? null,
      currency: d.currency,
      pipeline: stage?.pipelineLabel ?? d.pipelineExternalId,
      stage: stage?.label ?? d.stageExternalId,
      closeDate: d.closeDate?.toISOString() ?? null,
      nextActivityAt: d.nextActivityAt?.toISOString() ?? null,
      crmLastActivityAt: d.crmLastActivityAt?.toISOString() ?? null,
      owner: owner ? { name: personName(owner), email: owner.email, userId: owner.mapping?.userId ?? null } : null,
      health: d.health && ev
        ? { state: d.health.state, reasons: ev.reasons, limitedSignal: ev.emailCoverage.limitedSignal, evaluatedAt: d.health.evaluatedAt.toISOString() }
        : null,
      evidence: ev,
      contacts: d.contacts.map((c) => ({ name: personName(c.contact), email: c.contact.email })),
      companies: d.companies.map((c) => ({ name: c.company.name, domain: c.company.domain })),
      recommendation: rec ? { id: rec.id, status: rec.status, title: rec.title, summary: rec.summary, severity: rec.severity } : null,
      timeline: activity
        .filter((a) => emails.includes(a.counterpartEmail) || domains.some((dom) => domainMatches(a.counterpartDomain, dom)))
        .map((a) => ({
          occurredAt: a.occurredAt.toISOString(),
          direction: a.direction as "INBOUND" | "OUTBOUND",
          counterpartEmail: a.counterpartEmail,
          teammate: teammateBy.get(a.mailboxUserId) ?? null,
        })),
    };
  });
}
