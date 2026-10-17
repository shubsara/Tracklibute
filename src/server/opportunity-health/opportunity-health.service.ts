import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { type AuthContext, requireRole } from "@/domain/auth/auth-context";
import { isPublicEmailDomain, PUBLIC_EMAIL_DOMAINS } from "@/domain/email/activity";
import {
  describeEvaluation,
  evaluateDeal,
  type HealthEvaluation,
  healthFingerprint,
  type OpportunityHealthConfig,
} from "@/domain/opportunity-health/detector";
import { assertMetadataOnlyEvidence, type OpportunityHealthEvidence } from "@/domain/opportunity-health/evidence";
import { decideTransition, type RecommendationStatus } from "@/domain/recommendations/lifecycle";
import { parseSystemConfig } from "@/domain/responsibilities/templates";
import { ConflictError, NotFoundError, PolicyViolationError } from "@/lib/errors";
import { log } from "@/lib/log";
import { recordAudit } from "@/server/audit/audit-log";
import { type Tx, withOrgScope } from "@/server/db/org-scope";

/**
 * Opportunity Health responsibility run (Build Spec 03).
 *
 *   claim run (one active run per responsibility — DB partial unique index)
 *   → load open, non-archived deals + contacts / company domains
 *   → aggregate content-free EmailActivity per deal (org-readable layer; never
 *     touches owner-private email tables)
 *   → evaluateDeal (deterministic) → OpportunityHealth row per deal
 *   → recommendation lifecycle (one row per deal; create / refresh / reopen /
 *     resolve), metadata-only evidence validated against an allow-list
 *   → deals that closed / disappeared: recommendation resolved, health removed
 *
 * Deals whose open/closed status is unknown are skipped (counted, not judged).
 *
 * Read-only towards HubSpot: this run makes no provider calls at all.
 */
export const STALE_RUN_MS = 15 * 60_000;
const WRITE_CHUNK = 100;

export interface OpportunityHealthRunResult {
  runId: string;
  responsibilityId: string;
  dealsEvaluated: number;
  healthy: number;
  needsAttention: number;
  atRisk: number;
  limitedSignal: number;
  /** Open, non-archived deals NOT evaluated because their open/closed status is unknown. */
  skippedUnknownStatus: number;
  created: number;
  refreshed: number;
  reopened: number;
  resolved: number;
}

export interface OpportunityHealthRunOptions {
  trigger: "manual" | "cron" | "sync";
  now?: Date;
}

export const dedupeKeyForDeal = (dealId: string) => `opportunity_health:deal:${dealId}`;

const SEVERITY = { NEEDS_ATTENTION: "MEDIUM", AT_RISK: "HIGH" } as const;

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return Boolean(e && (e.code === "P2002" || (typeof e.message === "string" && /23505|unique constraint/i.test(e.message))));
}

interface EmailAggregate {
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  matched: number;
  lastTouchMailboxUserId: string | null;
}

async function aggregateEmailActivity(tx: Tx, organizationId: string, dealIds: string[]): Promise<Map<string, EmailAggregate>> {
  if (dealIds.length === 0) return new Map();
  const rows = await tx.$queryRaw<{ deal_id: string; last_in: Date | null; last_out: Date | null; matched: number; last_touch: string | null }[]>`
    WITH keys AS (
      SELECT dc.deal_id, c.email AS k, false AS is_domain
        FROM crm_deal_contacts dc JOIN crm_contacts c ON c.id = dc.contact_id
       WHERE dc.organization_id = ${organizationId}::uuid AND dc.deal_id = ANY(${dealIds}::uuid[]) AND c.email IS NOT NULL
      UNION
      SELECT dco.deal_id, co.domain, true
        FROM crm_deal_companies dco JOIN crm_companies co ON co.id = dco.company_id
       WHERE dco.organization_id = ${organizationId}::uuid AND dco.deal_id = ANY(${dealIds}::uuid[])
         AND co.domain IS NOT NULL AND NOT (co.domain = ANY(${[...PUBLIC_EMAIL_DOMAINS]}::text[]))
    )
    SELECT k.deal_id::text AS deal_id,
           max(a.occurred_at) FILTER (WHERE a.direction = 'INBOUND')  AS last_in,
           max(a.occurred_at) FILTER (WHERE a.direction = 'OUTBOUND') AS last_out,
           count(DISTINCT a.counterpart_email)::int AS matched,
           (array_agg(a.mailbox_user_id::text ORDER BY a.occurred_at DESC))[1] AS last_touch
      FROM keys k
      JOIN email_activities a
        ON a.organization_id = ${organizationId}::uuid
       AND ((NOT k.is_domain AND a.counterpart_email = k.k)
         OR (k.is_domain AND (a.counterpart_domain = k.k OR a.counterpart_domain LIKE '%.' || k.k)))
     GROUP BY k.deal_id`;
  return new Map(
    rows.map((r) => [r.deal_id, { lastInboundAt: r.last_in, lastOutboundAt: r.last_out, matched: r.matched, lastTouchMailboxUserId: r.last_touch }]),
  );
}

const iso = (d: Date | null) => d?.toISOString() ?? null;

export async function runOpportunityHealth(auth: AuthContext, opts: OpportunityHealthRunOptions): Promise<OpportunityHealthRunResult> {
  requireRole(auth, opts.trigger === "manual" ? "ADMIN" : "MEMBER");
  const actor = opts.trigger === "manual" ? "USER" : "SYSTEM";
  const now = opts.now ?? new Date();

  const { responsibility, integrationId, config } = await withOrgScope(auth, async (tx) => {
    const responsibility = await tx.responsibility.findFirst({
      where: { organizationId: auth.organizationId, templateKey: "opportunity_health" },
    });
    if (!responsibility) throw new NotFoundError("The Opportunity Health responsibility is not installed");
    if (responsibility.status !== "ACTIVE") throw new PolicyViolationError("Opportunity Health is paused");
    const integration = await tx.integration.findFirst({
      where: { organizationId: auth.organizationId, provider: "HUBSPOT", ownerUserId: null, status: "CONNECTED" },
      select: { id: true },
    });
    if (!integration) throw new PolicyViolationError("HubSpot is not connected");
    const config = parseSystemConfig("opportunity_health", responsibility.config) as unknown as OpportunityHealthConfig;
    return { responsibility, integrationId: integration.id, config };
  });

  // Claim the run. A crashed run older than STALE_RUN_MS is failed first.
  const run = await withOrgScope(auth, async (tx) => {
    await tx.responsibilityRun.updateMany({
      where: {
        organizationId: auth.organizationId,
        responsibilityId: responsibility.id,
        status: { in: ["QUEUED", "RUNNING"] },
        OR: [{ startedAt: { lt: new Date(Date.now() - STALE_RUN_MS) } }, { startedAt: null, createdAt: { lt: new Date(Date.now() - STALE_RUN_MS) } }],
      },
      data: { status: "FAILED", finishedAt: new Date(), error: "Run did not finish (stale)" },
    });
    return tx.responsibilityRun.create({
      data: { organizationId: auth.organizationId, responsibilityId: responsibility.id, status: "RUNNING", startedAt: new Date() },
      select: { id: true },
    });
  }).catch((err: unknown) => {
    if (isUniqueViolation(err)) throw new ConflictError("Opportunity Health is already running for this organization");
    throw err;
  });

  const result: OpportunityHealthRunResult = {
    runId: run.id,
    responsibilityId: responsibility.id,
    dealsEvaluated: 0,
    healthy: 0,
    needsAttention: 0,
    atRisk: 0,
    limitedSignal: 0,
    skippedUnknownStatus: 0,
    created: 0,
    refreshed: 0,
    reopened: 0,
    resolved: 0,
  };

  try {
    const data = await withOrgScope(auth, async (tx) => {
      const deals = await tx.crmDeal.findMany({
        where: { organizationId: auth.organizationId, integrationId, isClosed: false, archivedAt: null },
        select: {
          id: true,
          externalId: true,
          name: true,
          ownerExternalId: true,
          closeDate: true,
          externalCreatedAt: true,
          crmLastActivityAt: true,
          nextActivityAt: true,
          contacts: { select: { contact: { select: { email: true } } } },
          companies: { select: { company: { select: { domain: true } } } },
        },
      });
      // Deals whose open/closed status is unknown (stage metadata unavailable):
      // never evaluated, and their existing recommendations are left untouched
      // (neither refreshed nor resolved) so nothing misleading is produced.
      const unknown = await tx.crmDeal.findMany({
        where: { organizationId: auth.organizationId, integrationId, isClosed: null, archivedAt: null },
        select: { id: true },
      });
      const owners = await tx.crmOwner.findMany({
        where: { organizationId: auth.organizationId, integrationId, mapping: { isNot: null } },
        select: { externalId: true, mapping: { select: { userId: true } } },
      });
      const connected = await tx.$queryRaw<{ user_id: string }[]>`SELECT user_id::text FROM app_connected_mailbox_user_ids()`;
      const email = await aggregateEmailActivity(tx, auth.organizationId, deals.map((d) => d.id));
      const recs = await tx.recommendation.findMany({
        where: { organizationId: auth.organizationId, responsibilityId: responsibility.id, dedupeKey: { not: null } },
        select: { id: true, dedupeKey: true, status: true, fingerprint: true, snoozedUntil: true, dealId: true },
      });
      const health = await tx.opportunityHealth.findMany({
        where: { organizationId: auth.organizationId },
        select: { dealId: true, state: true },
      });
      return {
        deals,
        ownerUser: new Map(owners.map((o) => [o.externalId, o.mapping!.userId])),
        connectedUsers: new Set(connected.map((c) => c.user_id)),
        email,
        recByKey: new Map(recs.map((r) => [r.dedupeKey!, r])),
        recs,
        unknownIds: new Set(unknown.map((d) => d.id)),
        priorState: new Map(health.map((h) => [h.dealId, h.state])),
      };
    });

    const openIds = new Set(data.deals.map((d) => d.id));
    result.skippedUnknownStatus = data.unknownIds.size;
    for (let i = 0; i < data.deals.length; i += WRITE_CHUNK) {
      const chunk = data.deals.slice(i, i + WRITE_CHUNK);
      await withOrgScope(auth, async (tx) => {
        for (const deal of chunk) {
          const agg = data.email.get(deal.id) ?? { lastInboundAt: null, lastOutboundAt: null, matched: 0, lastTouchMailboxUserId: null };
          const trackable =
            deal.contacts.some((c) => c.contact.email) ||
            deal.companies.some((c) => c.company.domain && !isPublicEmailDomain(c.company.domain));
          const evaluation = evaluateDeal(
            {
              closeDate: deal.closeDate,
              externalCreatedAt: deal.externalCreatedAt,
              crmLastActivityAt: deal.crmLastActivityAt,
              nextActivityAt: deal.nextActivityAt,
              lastInboundAt: agg.lastInboundAt,
              lastOutboundAt: agg.lastOutboundAt,
              trackable,
            },
            config,
            now,
          );
          const ownerUserId = deal.ownerExternalId ? (data.ownerUser.get(deal.ownerExternalId) ?? null) : null;
          const ownerMailboxConnected = ownerUserId !== null && data.connectedUsers.has(ownerUserId);
          const evidence = assertMetadataOnlyEvidence({
            state: evaluation.state,
            reasons: evaluation.reasons,
            lastInboundAt: iso(agg.lastInboundAt),
            lastOutboundAt: iso(agg.lastOutboundAt),
            lastEmailAt: iso(evaluation.lastEmailAt),
            crmLastActivityAt: iso(deal.crmLastActivityAt),
            lastActivityAt: iso(evaluation.lastActivityAt),
            lastTouchMailboxUserId: agg.lastTouchMailboxUserId,
            matchedCounterpartCount: agg.matched,
            emailCoverage: {
              connectedMailboxes: data.connectedUsers.size,
              ownerMapped: ownerUserId !== null,
              ownerMailboxConnected,
              limitedSignal: !ownerMailboxConnected,
            },
            deal: { id: deal.id, externalId: deal.externalId },
          } satisfies OpportunityHealthEvidence);

          result.dealsEvaluated++;
          if (evaluation.state === "HEALTHY") result.healthy++;
          else if (evaluation.state === "NEEDS_ATTENTION") result.needsAttention++;
          else result.atRisk++;
          if (evidence.emailCoverage.limitedSignal) result.limitedSignal++;

          const prior = data.priorState.get(deal.id);
          await tx.opportunityHealth.upsert({
            where: { organizationId_dealId: { organizationId: auth.organizationId, dealId: deal.id } },
            create: {
              organizationId: auth.organizationId,
              dealId: deal.id,
              responsibilityRunId: run.id,
              state: evaluation.state,
              reasons: evidence as unknown as Prisma.InputJsonValue,
              evaluatedAt: now,
              stateChangedAt: now,
            },
            update: {
              responsibilityRunId: run.id,
              state: evaluation.state,
              reasons: evidence as unknown as Prisma.InputJsonValue,
              evaluatedAt: now,
              ...(prior !== evaluation.state ? { stateChangedAt: now } : {}),
            },
          });

          await applyRecommendation(tx, auth, {
            responsibilityId: responsibility.id,
            runId: run.id,
            deal,
            evaluation,
            evidence,
            existing: data.recByKey.get(dedupeKeyForDeal(deal.id)) ?? null,
            now,
            actor,
            result,
          });
        }
      });
    }

    // Deals no longer open (closed won/lost, archived, removed): resolve + drop health.
    await withOrgScope(auth, async (tx) => {
      for (const rec of data.recs) {
        if (rec.status === "RESOLVED" || (rec.dealId && (openIds.has(rec.dealId) || data.unknownIds.has(rec.dealId)))) continue;
        await resolveRecommendation(tx, auth, rec.id, now, actor, "deal_closed_or_removed");
        result.resolved++;
      }
      await tx.opportunityHealth.deleteMany({ where: { organizationId: auth.organizationId, dealId: { notIn: [...openIds] } } });
      await tx.responsibilityRun.update({
        where: { id: run.id },
        data: { status: "SUCCEEDED", finishedAt: new Date(), summary: { ...result, trigger: opts.trigger } as unknown as Prisma.InputJsonValue },
      });
      await recordAudit(tx, auth, {
        event: "opportunity_health.run_completed",
        entityType: "responsibility_run",
        entityId: run.id,
        metadata: { trigger: opts.trigger, ...result },
      }, { actor });
    });
    log.info("opportunity_health.run_completed", { organizationId: auth.organizationId, trigger: opts.trigger, ...result });
    return result;
  } catch (err) {
    await withOrgScope(auth, (tx) =>
      tx.responsibilityRun.update({
        where: { id: run.id },
        data: { status: "FAILED", finishedAt: new Date(), error: err instanceof Error ? err.name.slice(0, 100) : "error" },
      }),
    ).catch(() => undefined);
    log.error("opportunity_health.run_failed", {
      organizationId: auth.organizationId,
      runId: run.id,
      errorName: err instanceof Error ? err.name : typeof err,
    });
    throw err;
  }
}

async function resolveRecommendation(tx: Tx, auth: AuthContext, id: string, now: Date, actor: "USER" | "SYSTEM", reason: string) {
  await tx.recommendation.update({ where: { id }, data: { status: "RESOLVED", resolvedAt: now, snoozedUntil: null } });
  await recordAudit(tx, auth, { event: "recommendation.resolved", entityType: "recommendation", entityId: id, metadata: { reason } }, { actor });
}

async function applyRecommendation(
  tx: Tx,
  auth: AuthContext,
  input: {
    responsibilityId: string;
    runId: string;
    deal: { id: string; externalId: string; name: string };
    evaluation: HealthEvaluation;
    evidence: OpportunityHealthEvidence;
    existing: { id: string; status: RecommendationStatus; fingerprint: string | null; snoozedUntil: Date | null } | null;
    now: Date;
    actor: "USER" | "SYSTEM";
    result: OpportunityHealthRunResult;
  },
): Promise<void> {
  const { evaluation, existing, now, actor, result } = input;
  const unhealthy = evaluation.state !== "HEALTHY";
  const fingerprint = healthFingerprint(evaluation);
  const decision = decideTransition(existing, unhealthy ? { fingerprint } : null, now);
  if (decision.kind === "noop") return;
  if (decision.kind === "resolve") {
    await resolveRecommendation(tx, auth, existing!.id, now, actor, "deal_healthy");
    result.resolved++;
    return;
  }

  const { title, summary } = describeEvaluation(input.deal.name, evaluation);
  const fields = {
    title,
    summary,
    severity: SEVERITY[evaluation.state as "NEEDS_ATTENTION" | "AT_RISK"],
    evidence: input.evidence as unknown as Prisma.InputJsonValue,
    subjectRef: { provider: "HUBSPOT", kind: "deal", externalId: input.deal.externalId } as Prisma.InputJsonValue,
    lastDetectedAt: now,
    responsibilityRunId: input.runId,
    dealId: input.deal.id,
  };

  if (decision.kind === "create") {
    const rec = await tx.recommendation.create({
      data: {
        organizationId: auth.organizationId,
        responsibilityId: input.responsibilityId,
        dedupeKey: dedupeKeyForDeal(input.deal.id),
        fingerprint,
        status: "OPEN",
        ...fields,
      },
      select: { id: true },
    });
    await recordAudit(tx, auth, { event: "recommendation.created", entityType: "recommendation", entityId: rec.id, metadata: { fingerprint } }, { actor });
    result.created++;
  } else if (decision.kind === "reopen") {
    await tx.recommendation.update({
      where: { id: existing!.id },
      data: { ...fields, fingerprint, status: "OPEN", snoozedUntil: null, resolvedAt: null },
    });
    await recordAudit(tx, auth, { event: "recommendation.reopened", entityType: "recommendation", entityId: existing!.id, metadata: { from: existing!.status, fingerprint } }, { actor });
    result.reopened++;
  } else {
    await tx.recommendation.update({
      where: { id: existing!.id },
      data: { ...fields, ...(decision.keepFingerprint ? {} : { fingerprint }) },
    });
    result.refreshed++;
  }
}
