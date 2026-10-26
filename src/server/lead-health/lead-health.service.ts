import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { requireRole, type AuthContext } from "@/domain/auth/auth-context";
import { isPublicEmailDomain } from "@/domain/email/activity";
import { describeLeadEvaluation, evaluateLead, leadHealthFingerprint, type LeadFacts, type LeadHealthConfig, type LeadHealthEvaluation } from "@/domain/lead-health/detector";
import { assertLeadHealthEvidence, type LeadHealthEvidence } from "@/domain/lead-health/evidence";
import { decideTransition, type RecommendationStatus } from "@/domain/recommendations/lifecycle";
import { parseSystemConfig } from "@/domain/responsibilities/templates";
import { AppError, ConflictError, NotFoundError, PolicyViolationError } from "@/lib/errors";
import { log } from "@/lib/log";
import { recordAudit } from "@/server/audit/audit-log";
import { type Tx, withOrgScope } from "@/server/db/org-scope";

const STALE_RUN_MS = 15 * 60_000;
const WRITE_CHUNK = 100;
const KEY_PREFIX = "lead_health:contact:";
const SEVERITY = { NEEDS_ATTENTION: "MEDIUM", AT_RISK: "HIGH" } as const;
const dedupeKeyForContact = (id: string) => KEY_PREFIX + id;

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return Boolean(e && (e.code === "P2002" || (typeof e.message === "string" && /23505|unique constraint/i.test(e.message))));
}
const iso = (d: Date | null) => d?.toISOString() ?? null;
const latest = (...dates: (Date | null)[]): Date | null =>
  dates.reduce<Date | null>((a, b) => (b && (!a || b > a) ? b : a), null);
const normalizeCode = (value: string | null): string => (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 64);

interface ContactActivity {
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  lastAccountActivityAt: Date | null;
  matched: number;
}

async function aggregateContactActivity(tx: Tx, organizationId: string, contacts: Array<{ id: string; email: string | null }>): Promise<Map<string, ContactActivity>> {
  const eligible = contacts.filter((c): c is { id: string; email: string } => Boolean(c.email));
  if (eligible.length === 0) return new Map();
  const emails = [...new Set(eligible.map((c) => c.email.toLowerCase()))];
  const domains = [...new Set(eligible
    .map((c) => c.email.split("@").at(-1)?.toLowerCase() ?? "")
    .filter((domain) => domain && !isPublicEmailDomain(domain)))];
  const activities = await tx.emailActivity.findMany({
    where: { organizationId, OR: [
      { counterpartEmail: { in: emails } },
      ...(domains.length ? [{ counterpartDomain: { in: domains } }] : []),
    ] },
    select: { counterpartEmail: true, counterpartDomain: true, direction: true, occurredAt: true },
  });
  const out = new Map<string, ContactActivity>();
  for (const contact of eligible) {
    const email = contact.email.toLowerCase();
    const domain = email.split("@").at(-1)?.toLowerCase() ?? "";
    const accountActivity = domain && !isPublicEmailDomain(domain)
      ? activities.filter((a) => a.counterpartEmail.toLowerCase() !== email && a.counterpartDomain.toLowerCase() === domain)
      : [];
    const direct = activities.filter((a) => a.counterpartEmail.toLowerCase() === email);
    out.set(contact.id, {
      lastInboundAt: direct.filter((a) => a.direction === "INBOUND").reduce<Date | null>((d, a) => !d || a.occurredAt > d ? a.occurredAt : d, null),
      lastOutboundAt: direct.filter((a) => a.direction === "OUTBOUND").reduce<Date | null>((d, a) => !d || a.occurredAt > d ? a.occurredAt : d, null),
      lastAccountActivityAt: accountActivity.reduce<Date | null>((d, a) => !d || a.occurredAt > d ? a.occurredAt : d, null),
      matched: direct.length,
    });
  }
  return out;
}

function qualifyContact(
  contact: { lifecycleStage: string | null; leadStatus: string | null; deals: Array<{ deal: { isClosed: boolean | null; isWon: boolean | null; archivedAt: Date | null } }> },
  config: LeadHealthConfig,
): { eligible: boolean; priorClosedLost: boolean } {
  const lifecycle = normalizeCode(contact.lifecycleStage);
  const status = normalizeCode(contact.leadStatus);
  if (status === "unqualified" || status === "badtiming" || lifecycle === "customer") return { eligible: false, priorClosedLost: false };
  const sql = lifecycle === "salesqualifiedlead";
  const mql = lifecycle === "marketingqualifiedlead" && config.includeMarketingQualifiedLeads;
  // Only an explicitly closed-lost history can remain eligible for reactivation.
  // Active, unknown-status and closed-won deals belong to Opportunity Health or
  // customer/expansion workflows, not this pre-opportunity responsibility.
  const hasNonLostDeal = contact.deals.some(
    ({ deal }) => deal.archivedAt === null && !(deal.isClosed === true && deal.isWon === false),
  );
  const priorClosedLost = contact.deals.some(({ deal }) => deal.archivedAt === null && deal.isClosed === true && deal.isWon === false);
  // A known closed-lost deal is an explicit reactivation exception: HubSpot may
  // have advanced the contact lifecycle to Opportunity when the old deal was
  // created, so don't require the contact to be reset to SQL manually.
  if ((!sql && !mql && !priorClosedLost) || hasNonLostDeal) return { eligible: false, priorClosedLost };
  return { eligible: true, priorClosedLost };
}

export interface LeadHealthRunResult {
  runId: string; responsibilityId: string; contactsEvaluated: number; healthy: number;
  needsAttention: number; atRisk: number; limitedSignal: number;
  created: number; refreshed: number; reopened: number; resolved: number;
}
export interface LeadHealthRunOptions { trigger: "manual" | "sync"; now?: Date; }

export async function runLeadHealth(auth: AuthContext, opts: LeadHealthRunOptions): Promise<LeadHealthRunResult> {
  requireRole(auth, opts.trigger === "manual" ? "ADMIN" : "MEMBER");
  const actor = opts.trigger === "manual" ? "USER" : "SYSTEM";
  const now = opts.now ?? new Date();
  const { responsibility, integrationId, config } = await withOrgScope(auth, async (tx) => {
    const responsibility = await tx.responsibility.findFirst({ where: { organizationId: auth.organizationId, templateKey: "lead_health" } });
    if (!responsibility) throw new NotFoundError("The Lead Health responsibility is not installed. An admin can install default responsibilities from Settings → Integrations.");
    if (responsibility.status !== "ACTIVE") throw new PolicyViolationError("Lead Health is paused");
    const integration = await tx.integration.findFirst({
      where: { organizationId: auth.organizationId, provider: "HUBSPOT", ownerUserId: null, status: "CONNECTED" },
      select: { id: true },
    });
    if (!integration) throw new PolicyViolationError("HubSpot is not connected");
    const config = parseSystemConfig("lead_health", responsibility.config) as unknown as LeadHealthConfig;
    return { responsibility, integrationId: integration.id, config };
  });

  const run = await withOrgScope(auth, async (tx) => {
    await tx.responsibilityRun.updateMany({
      where: {
        organizationId: auth.organizationId, responsibilityId: responsibility.id, status: { in: ["QUEUED", "RUNNING"] },
        OR: [{ startedAt: { lt: new Date(Date.now() - STALE_RUN_MS) } }, { startedAt: null, createdAt: { lt: new Date(Date.now() - STALE_RUN_MS) } }],
      },
      data: { status: "FAILED", finishedAt: new Date(), error: "Run did not finish (stale)" },
    });
    return tx.responsibilityRun.create({
      data: { organizationId: auth.organizationId, responsibilityId: responsibility.id, status: "RUNNING", startedAt: new Date() },
      select: { id: true },
    });
  }).catch((err: unknown) => {
    if (isUniqueViolation(err)) throw new ConflictError("Lead Health is already running for this organization");
    throw err;
  });

  const result: LeadHealthRunResult = {
    runId: run.id, responsibilityId: responsibility.id, contactsEvaluated: 0, healthy: 0,
    needsAttention: 0, atRisk: 0, limitedSignal: 0, created: 0, refreshed: 0, reopened: 0, resolved: 0,
  };

  try {
    const data = await withOrgScope(auth, async (tx) => {
      const contacts = await tx.crmContact.findMany({
        where: { organizationId: auth.organizationId, integrationId, archivedAt: null },
        select: {
          id: true, externalId: true, email: true, firstName: true, lastName: true, lifecycleStage: true, ownerExternalId: true,
          leadStatus: true, dateEnteredSalesQualifiedLead: true, dateEnteredMarketingQualifiedLead: true,
          crmLastActivityAt: true, crmLastContactedAt: true, nextActivityAt: true,
          deals: { select: { deal: { select: { isClosed: true, isWon: true, archivedAt: true } } } },
        },
      });
      const [connected, owners] = await Promise.all([
        // This SECURITY DEFINER helper returns mailbox-owner IDs without exposing
        // another member's private Gmail integration row to the current actor.
        tx.$queryRaw<{ user_id: string }[]>`SELECT user_id::text FROM app_connected_mailbox_user_ids()`,
        tx.crmOwner.findMany({
          where: { organizationId: auth.organizationId, integrationId, mapping: { isNot: null } },
          select: { externalId: true, mapping: { select: { userId: true } } },
        }),
      ]);
      const activity = await aggregateContactActivity(tx, auth.organizationId, contacts.map((c) => ({ id: c.id, email: c.email })));
      const recs = await tx.recommendation.findMany({
        where: { organizationId: auth.organizationId, responsibilityId: responsibility.id, dedupeKey: { startsWith: KEY_PREFIX } },
        select: { id: true, dedupeKey: true, status: true, fingerprint: true, snoozedUntil: true },
      });
      return {
        contacts,
        connectedMailboxCount: connected.length,
        connectedUsers: new Set(connected.map((i) => i.user_id)),
        ownerUser: new Map(owners.map((o) => [o.externalId, o.mapping!.userId] as const)),
        activity, recs,
        recByKey: new Map(recs.flatMap((r) => r.dedupeKey ? [[r.dedupeKey, r] as const] : [])),
      };
    });

    const evaluatedKeys = new Set<string>();
    for (let i = 0; i < data.contacts.length; i += WRITE_CHUNK) {
      await withOrgScope(auth, async (tx) => {
        for (const contact of data.contacts.slice(i, i + WRITE_CHUNK)) {
          const qualification = qualifyContact(contact, config);
          const key = dedupeKeyForContact(contact.id);
          const existing = data.recByKey.get(key) ?? null;
          // A missing email means Gmail activity cannot be matched. Do not
          // guess that the prospect is cold; CRM Hygiene can surface the gap.
          if (!qualification.eligible || !contact.email) continue;
          const normalizedStage = normalizeCode(contact.lifecycleStage);
          const qualificationAt = normalizedStage === "salesqualifiedlead"
            ? contact.dateEnteredSalesQualifiedLead : contact.dateEnteredMarketingQualifiedLead;
          const agg = data.activity.get(contact.id) ?? { lastInboundAt: null, lastOutboundAt: null, lastAccountActivityAt: null, matched: 0 };
          const facts: LeadFacts = {
            qualificationAt, lastInboundAt: agg.lastInboundAt, lastOutboundAt: agg.lastOutboundAt,
            crmLastActivityAt: contact.crmLastActivityAt, crmLastContactedAt: contact.crmLastContactedAt,
            nextActivityAt: contact.nextActivityAt,
          };
          const evaluation = evaluateLead(facts, config, now);
          evaluatedKeys.add(key);
          result.contactsEvaluated++;
          if (evaluation.state === "HEALTHY") result.healthy++;
          else if (evaluation.state === "NEEDS_ATTENTION") result.needsAttention++;
          else result.atRisk++;
          const ownerUserId = contact.ownerExternalId ? (data.ownerUser.get(contact.ownerExternalId) ?? null) : null;
          const ownerMapped = ownerUserId !== null;
          const ownerMailboxConnected = ownerUserId !== null && data.connectedUsers.has(ownerUserId);
          const limitedSignal = !ownerMailboxConnected;
          if (limitedSignal) result.limitedSignal++;

          const lastAnyActivity = latest(agg.lastInboundAt, agg.lastOutboundAt, contact.crmLastActivityAt, contact.crmLastContactedAt);
          const accountMoreRecentlyActive = Boolean(agg.lastAccountActivityAt && (!lastAnyActivity || agg.lastAccountActivityAt > lastAnyActivity));
          const lifecycleStage = normalizedStage || null;
          const leadStatus = normalizeCode(contact.leadStatus) || null;
          const evidence = assertLeadHealthEvidence({
            state: evaluation.state, reasons: evaluation.reasons, qualificationAt: iso(qualificationAt),
            lastInboundAt: iso(agg.lastInboundAt), lastOutboundAt: iso(agg.lastOutboundAt),
            lastActivityAt: iso(evaluation.lastActivityAt), crmLastActivityAt: iso(contact.crmLastActivityAt),
            crmLastContactedAt: iso(contact.crmLastContactedAt), nextActivityAt: iso(contact.nextActivityAt),
            lastAccountActivityAt: iso(agg.lastAccountActivityAt), accountMoreRecentlyActive,
            lifecycleStage, leadStatus, connectedMailboxes: data.connectedMailboxCount, ownerMapped, ownerMailboxConnected, limitedSignal,
            priorClosedLost: qualification.priorClosedLost, contact: { id: contact.id, externalId: contact.externalId },
          } satisfies LeadHealthEvidence);

          await applyLeadRecommendation(tx, auth, {
            responsibilityId: responsibility.id, runId: run.id,
            contact: { id: contact.id, externalId: contact.externalId, name: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || "Qualified lead" },
            evaluation, evidence, existing, now, actor, result,
            priorClosedLost: qualification.priorClosedLost, accountMoreRecentlyActive,
          });
        }
      });
    }

    await withOrgScope(auth, async (tx) => {
      for (const rec of data.recs) {
        if (!rec.dedupeKey || evaluatedKeys.has(rec.dedupeKey) || rec.status === "RESOLVED") continue;
        await resolveLeadRecommendation(tx, auth, rec.id, now, actor, "lead_healthy_or_no_longer_eligible");
        result.resolved++;
      }
      await tx.responsibilityRun.update({
        where: { id: run.id }, data: { status: "SUCCEEDED", finishedAt: new Date(), summary: { ...result, trigger: opts.trigger } as unknown as Prisma.InputJsonValue },
      });
      await recordAudit(tx, auth, {
        event: "lead_health.run_completed", entityType: "responsibility_run", entityId: run.id, metadata: { trigger: opts.trigger, ...result },
      }, { actor });
    });
    log.info("lead_health.run_completed", { organizationId: auth.organizationId, trigger: opts.trigger, ...result });
    return result;
  } catch (err) {
    await withOrgScope(auth, (tx) => tx.responsibilityRun.update({
      where: { id: run.id }, data: { status: "FAILED", finishedAt: new Date(), error: safeErrorCode(err) },
    })).catch(() => undefined);
    log.error("lead_health.run_failed", { organizationId: auth.organizationId, runId: run.id, errorCode: safeErrorCode(err), errorName: err instanceof Error ? err.name : typeof err });
    throw err;
  }
}

async function resolveLeadRecommendation(tx: Tx, auth: AuthContext, id: string, now: Date, actor: "USER" | "SYSTEM", reason: string): Promise<void> {
  await tx.recommendation.update({ where: { id }, data: { status: "RESOLVED", resolvedAt: now, snoozedUntil: null } });
  await recordAudit(tx, auth, { event: "recommendation.resolved", entityType: "recommendation", entityId: id, metadata: { reason } }, { actor });
}

async function applyLeadRecommendation(
  tx: Tx,
  auth: AuthContext,
  input: {
    responsibilityId: string; runId: string; contact: { id: string; externalId: string; name: string };
    evaluation: LeadHealthEvaluation; evidence: LeadHealthEvidence;
    existing: { id: string; status: RecommendationStatus; fingerprint: string | null; snoozedUntil: Date | null } | null;
    now: Date; actor: "USER" | "SYSTEM"; result: LeadHealthRunResult; priorClosedLost: boolean; accountMoreRecentlyActive: boolean;
  },
): Promise<void> {
  const { evaluation, existing, now, actor, result } = input;
  const unhealthy = evaluation.state !== "HEALTHY";
  const fingerprint = leadHealthFingerprint(evaluation);
  const decision = decideTransition(existing, unhealthy ? { fingerprint } : null, now);
  if (decision.kind === "noop") return;
  if (decision.kind === "resolve") {
    await resolveLeadRecommendation(tx, auth, existing!.id, now, actor, "lead_healthy");
    result.resolved++;
    return;
  }
  const described = describeLeadEvaluation(input.contact.name, evaluation);
  const context: string[] = [];
  if (input.priorClosedLost) context.push("A prior closed-lost deal exists; consider whether this is a reactivation opportunity.");
  if (input.accountMoreRecentlyActive) context.push("Other activity at this business email domain is more recent; it does not prove this contact was reached.");
  if (input.evidence.limitedSignal) context.push("Gmail coverage may be limited because this contact owner is unmapped or has no connected mailbox.");
  const fields = {
    title: described.title, summary: [described.summary, ...context].join(" "),
    severity: SEVERITY[evaluation.state as "NEEDS_ATTENTION" | "AT_RISK"],
    evidence: input.evidence as unknown as Prisma.InputJsonValue,
    subjectRef: { provider: "HUBSPOT", kind: "contact", externalId: input.contact.externalId } as Prisma.InputJsonValue,
    lastDetectedAt: now, responsibilityRunId: input.runId, dealId: null,
  };
  if (decision.kind === "create") {
    const rec = await tx.recommendation.create({
      data: { organizationId: auth.organizationId, responsibilityId: input.responsibilityId, dedupeKey: dedupeKeyForContact(input.contact.id), fingerprint, status: "OPEN", ...fields },
      select: { id: true },
    });
    await recordAudit(tx, auth, { event: "recommendation.created", entityType: "recommendation", entityId: rec.id, metadata: { fingerprint } }, { actor });
    result.created++;
  } else if (decision.kind === "reopen") {
    await tx.recommendation.update({
      where: { id: existing!.id }, data: { ...fields, fingerprint, status: "OPEN", snoozedUntil: null, resolvedAt: null },
    });
    await recordAudit(tx, auth, { event: "recommendation.reopened", entityType: "recommendation", entityId: existing!.id, metadata: { from: existing!.status, fingerprint } }, { actor });
    result.reopened++;
  } else {
    await tx.recommendation.update({
      where: { id: existing!.id }, data: { ...fields, ...(decision.keepFingerprint ? {} : { fingerprint }) },
    });
    result.refreshed++;
  }
}

function safeErrorCode(err: unknown): string {
  if (err instanceof AppError) return err.code;
  return (err instanceof Error ? err.name : typeof err).slice(0, 100);
}

export async function runLeadHealthAfterSync(
  auth: AuthContext,
  trigger: "hubspot_connect" | "hubspot_manual" | "hubspot_cron" | "gmail_sync",
): Promise<{ status: "succeeded"; result: LeadHealthRunResult } | { status: "skipped"; reason: "already_running" | "not_ready" } | { status: "failed"; errorCode: string; message: string }> {
  try {
    const ready = await withOrgScope(auth, async (tx) => {
      const [responsibility, hubspot] = await Promise.all([
        tx.responsibility.findFirst({
          where: { organizationId: auth.organizationId, templateKey: "lead_health", status: "ACTIVE" },
          select: { id: true },
        }),
        tx.integration.findFirst({
          where: { organizationId: auth.organizationId, provider: "HUBSPOT", ownerUserId: null, status: "CONNECTED" },
          select: { id: true },
        }),
      ]);
      return Boolean(responsibility && hubspot);
    });
    if (!ready) return { status: "skipped", reason: "not_ready" };
    return { status: "succeeded", result: await runLeadHealth(auth, { trigger: "sync" }) };
  } catch (err) {
    if (err instanceof ConflictError) {
      log.info("lead_health.post_sync_skipped", { organizationId: auth.organizationId, syncTrigger: trigger, reason: "already_running" });
      return { status: "skipped", reason: "already_running" };
    }
    const errorCode = safeErrorCode(err);
    const message = err instanceof AppError ? err.message : "Lead Health failed unexpectedly.";
    log.error("lead_health.post_sync_failed", { organizationId: auth.organizationId, syncTrigger: trigger, errorCode, errorName: err instanceof Error ? err.name : typeof err });
    await withOrgScope(auth, (tx) => recordAudit(
      tx, auth,
      { event: "lead_health.post_sync_failed", entityType: "organization", entityId: auth.organizationId, metadata: { syncTrigger: trigger, errorCode, message } },
      { actor: "SYSTEM" },
    )).catch((auditErr: unknown) => {
      log.error("lead_health.post_sync_failure_not_recorded", { organizationId: auth.organizationId, errorName: auditErr instanceof Error ? auditErr.name : typeof auditErr });
    });
    return { status: "failed", errorCode, message };
  }
}
