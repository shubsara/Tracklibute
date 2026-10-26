import "server-only";

import { type AuthContext, requireRole } from "@/domain/auth/auth-context";
import {
  CrmAuthorizationRevokedError,
  type CrmCompanyRecord,
  type CrmContactRecord,
  type CrmDealRecord,
  CrmError,
  type CrmOwnerRecord,
  type CrmSource,
  type CrmStageRecord,
} from "@/domain/crm/types";
import { getEnv } from "@/lib/env";
import { AppError, ConflictError, NotFoundError, PolicyViolationError, UpstreamServiceError } from "@/lib/errors";
import { log } from "@/lib/log";
import { recordAudit } from "@/server/audit/audit-log";
import { type Tx, withOrgScope } from "@/server/db/org-scope";
import { autoMapOwners } from "@/server/crm/owner-mapping.service";

import { type Clock, realClock } from "../pacing";
import { createHubSpotCrmSource } from "./hubspot.adapter";
import { findHubSpotIntegration } from "./hubspot-connection.service";
import { markHubSpotReauthRequired } from "./hubspot-reauth";

/**
 * HubSpotSyncService — read-only CRM mirror.
 *
 *   claim lease ─▶ owners + pipeline stages (every run, cheap)
 *              ─▶ full reconcile due? (never done / > 24 h / in progress)
 *                   yes ─▶ FULL: list all deals (+ embedded associations),
 *                          resumable via backfill_cursor {after, passStartedAt};
 *                          when the pass COMPLETES, deals not seen are archived
 *                   no  ─▶ INCREMENTAL: search hs_lastmodifieddate ≥ watermark,
 *                          oldest first; associations via v4 batch read;
 *                          re-anchors the watermark at HubSpot's 10k result cap
 *
 *   All contacts (including standalone leads) are reconciled after deals.
 *   Runs are time-boxed (HUBSPOT_SYNC_RUN_BUDGET_SECONDS); a run that stops on
 *   budget or the daily-allowance reserve ends PARTIAL and resumes next run.
 *   All writes are idempotent upserts under the caller's AuthContext + RLS.
 *   Not a word is written back to HubSpot.
 */
export const LEASE_SECONDS = 10 * 60;
export const FULL_RECONCILE_EVERY_MS = 24 * 3_600_000;
/** Replay window after a full pass, so edits made during the pass are not missed. */
const WATERMARK_OVERLAP_MS = 60_000;

export type HubSpotSyncMode = "full" | "incremental";
export type HubSpotSyncOutcome = "completed" | "partial";

export interface HubSpotSyncResult {
  integrationId: string;
  mode: HubSpotSyncMode;
  outcome: HubSpotSyncOutcome;
  trigger: "manual" | "cron" | "connect";
  resumed: boolean;
  dealsUpserted: number;
  dealsArchived: number;
  contactsUpserted: number;
  contactsArchived: number;
  companiesUpserted: number;
  ownersUpserted: number;
  stagesUpserted: number;
  ownersAutoMapped: number;
  /** Deals whose stage is not in the known stage metadata. */
  dealsWithUnknownStage: number;
  /** Deals whose open/closed status could not be determined (stored as unknown). */
  dealsClosedStatusUnknown: number;
  /** Whether deal pipeline/stage metadata could be read this run. */
  pipelineMetadata: "OK" | "UNAVAILABLE";
  durationMs: number;
}

export interface HubSpotSyncOptions {
  trigger: "manual" | "cron" | "connect";
  /** Injected in tests; defaults to the HubSpot adapter. */
  source?: CrmSource;
  clock?: Clock;
  deadlineAt?: number;
  /** Force a full reconcile pass this run. */
  forceFull?: boolean;
}

class LeaseLostError extends Error {
  constructor() {
    super("Sync lease expired or was taken over");
    this.name = "LeaseLostError";
  }
}

interface WatermarkCursor {
  /** v1 predates the contact mirror; v2 confirms a complete contact reconcile. */
  v: 1 | 2;
  watermark: number;
}
interface FullPassCursor {
  v: 1;
  phase?: "deals" | "contacts";
  after: string | null;
  passStartedAt: string;
}

function parseJson<T>(raw: string | null, check: (v: Record<string, unknown>) => boolean): T | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return v && typeof v === "object" && check(v) ? (v as T) : null;
  } catch {
    return null;
  }
}
const parseWatermark = (raw: string | null) => parseJson<WatermarkCursor>(raw, (v) => (v.v === 1 || v.v === 2) && typeof v.watermark === "number");
const parseFullPass = (raw: string | null) =>
  parseJson<FullPassCursor>(raw, (v) =>
    typeof v.passStartedAt === "string" &&
    (v.after === null || typeof v.after === "string") &&
    (v.phase === undefined || v.phase === "deals" || v.phase === "contacts"),
  );

interface SyncCtx {
  auth: AuthContext;
  integrationId: string;
  lease: Date;
  clock: Clock;
  deadlineAt: number;
  stages: Map<string, Pick<CrmStageRecord, "isClosed" | "isWon">>;
  pipelineMetadata: "OK" | "UNAVAILABLE";
  counters: Omit<HubSpotSyncResult, "integrationId" | "mode" | "outcome" | "trigger" | "resumed" | "durationMs" | "pipelineMetadata">;
  seenContactExternalIds: Set<string>;
}

const budgetExhausted = (ctx: SyncCtx) => ctx.clock.now() >= ctx.deadlineAt;

async function claimLease(auth: AuthContext, integrationId: string): Promise<Date | null> {
  return withOrgScope(auth, async (tx) => {
    const rows = await tx.$queryRaw<{ lease: Date }[]>`
      UPDATE integrations
         SET sync_lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS}),
             last_sync_attempt_at = now(), updated_at = now()
       WHERE id = ${integrationId}::uuid
         AND organization_id = ${auth.organizationId}::uuid
         AND provider = 'HUBSPOT' AND owner_user_id IS NULL
         AND status = 'CONNECTED'
         AND (sync_lease_expires_at IS NULL OR sync_lease_expires_at < now())
      RETURNING sync_lease_expires_at AS lease`;
    return rows[0]?.lease ?? null;
  });
}

/** Compare-and-set integration columns while we still hold the lease (also extends it). */
async function checkpoint(ctx: SyncCtx, data: { syncCursor?: string | null; backfillCursor?: string | null }): Promise<void> {
  const rows = await withOrgScope(ctx.auth, (tx) => tx.$queryRaw<{ lease: Date }[]>`
    UPDATE integrations
       SET sync_cursor = CASE WHEN ${data.syncCursor !== undefined} THEN ${data.syncCursor ?? null} ELSE sync_cursor END,
           backfill_cursor = CASE WHEN ${data.backfillCursor !== undefined} THEN ${data.backfillCursor ?? null} ELSE backfill_cursor END,
           sync_lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS}),
           updated_at = now()
     WHERE id = ${ctx.integrationId}::uuid AND sync_lease_expires_at = ${ctx.lease}
    RETURNING sync_lease_expires_at AS lease`);
  if (!rows[0]) throw new LeaseLostError();
  ctx.lease = rows[0].lease;
}

// ─── Owners + stages ────────────────────────────────────────────────────────

/**
 * Deal pipeline metadata (GET /crm/pipelines/2026-09/deals). A revoked grant,
 * missing scope, rate limit or outage propagates as usual. If HubSpot refuses
 * or returns an unusable shape (403 without MISSING_SCOPES, 404, malformed),
 * the run continues WITHOUT fresh stage metadata: previously stored stages
 * (real HubSpot data) are kept, nothing is invented, and the integration is
 * marked pipeline-metadata UNAVAILABLE with a safe reason code.
 */
async function fetchDealStages(ctx: SyncCtx, source: CrmSource): Promise<{ stages: readonly CrmStageRecord[] | null; error: string | null }> {
  try {
    return { stages: await source.listDealStages(), error: null };
  } catch (err) {
    if (err instanceof CrmError && (err.kind === "forbidden" || err.kind === "invalid_response")) {
      log.warn("hubspot.pipelines_unavailable", {
        organizationId: ctx.auth.organizationId,
        integrationId: ctx.integrationId,
        reason: err.kind,
        ...err.diagnostics,
      });
      return { stages: null, error: err.diagnostics.httpStatus === 404 ? "not_found" : err.kind };
    }
    throw err;
  }
}

async function syncOwnersAndStages(ctx: SyncCtx, source: CrmSource): Promise<void> {
  const owners: CrmOwnerRecord[] = [];
  let after: string | undefined;
  do {
    const page = await source.listOwners(after);
    owners.push(...page.items);
    after = page.next ?? undefined;
  } while (after);
  const fetched = await fetchDealStages(ctx, source);
  const stages = fetched.stages ?? [];

  const { auth, integrationId } = ctx;
  const scope = { organizationId: auth.organizationId, integrationId };
  await withOrgScope(auth, async (tx) => {
    for (const o of owners) {
      const data = { email: o.email, firstName: o.firstName, lastName: o.lastName, archived: o.archived };
      await tx.crmOwner.upsert({
        where: { organizationId_integrationId_externalId: { ...scope, externalId: o.externalId } },
        create: { ...scope, externalId: o.externalId, ...data },
        update: data,
      });
    }
    // Owners HubSpot no longer lists (deactivated users) are archived, not deleted.
    await tx.crmOwner.updateMany({
      where: { ...scope, archived: false, externalId: { notIn: owners.map((o) => o.externalId) } },
      data: { archived: true },
    });
    for (const s of stages) {
      const data = {
        pipelineLabel: s.pipelineLabel,
        label: s.label,
        displayOrder: s.displayOrder,
        isClosed: s.isClosed,
        isWon: s.isWon,
        probability: s.probability,
      };
      await tx.crmPipelineStage.upsert({
        where: {
          organizationId_integrationId_pipelineExternalId_externalId: {
            ...scope,
            pipelineExternalId: s.pipelineExternalId,
            externalId: s.externalId,
          },
        },
        create: { ...scope, pipelineExternalId: s.pipelineExternalId, externalId: s.externalId, ...data },
        update: data,
      });
    }
    // Only a successful fetch may remove stages HubSpot no longer reports.
    if (fetched.stages && stages.length) {
      const keep = new Set(stages.map((s) => `${s.pipelineExternalId}/${s.externalId}`));
      const all = await tx.crmPipelineStage.findMany({ where: scope, select: { id: true, pipelineExternalId: true, externalId: true } });
      const stale = all.filter((s) => !keep.has(`${s.pipelineExternalId}/${s.externalId}`)).map((s) => s.id);
      if (stale.length) await tx.crmPipelineStage.deleteMany({ where: { ...scope, id: { in: stale } } });
    }
    const n = await tx.$executeRaw`
      UPDATE integrations
         SET pipeline_metadata_status = ${fetched.stages ? "OK" : "UNAVAILABLE"},
             pipeline_metadata_error = ${fetched.error}, updated_at = now()
       WHERE id = ${integrationId}::uuid AND sync_lease_expires_at = ${ctx.lease}`;
    if (n === 0) throw new LeaseLostError();
  });
  ctx.pipelineMetadata = fetched.stages ? "OK" : "UNAVAILABLE";
  if (fetched.stages) {
    ctx.stages = new Map(stages.map((s) => [`${s.pipelineExternalId}/${s.externalId}`, s]));
  } else {
    // Fall back to the last stage metadata HubSpot actually returned (if any).
    const stored = await withOrgScope(auth, (tx) =>
      tx.crmPipelineStage.findMany({ where: scope, select: { pipelineExternalId: true, externalId: true, isClosed: true, isWon: true } }),
    );
    ctx.stages = new Map(stored.map((s) => [`${s.pipelineExternalId}/${s.externalId}`, { isClosed: s.isClosed, isWon: s.isWon }]));
  }
  ctx.counters.ownersUpserted += owners.length;
  ctx.counters.stagesUpserted += stages.length;
  ctx.counters.ownersAutoMapped += await autoMapOwners(auth, integrationId);
}

// ─── Deals (+ associated contacts / companies) ──────────────────────────────

async function upsertContacts(
  tx: Tx,
  scope: { organizationId: string; integrationId: string },
  rows: readonly CrmContactRecord[],
  seenAt: Date | null,
) {
  const ids = new Map<string, string>();
  for (const c of rows) {
    const data = {
      email: c.email,
      firstName: c.firstName,
      lastName: c.lastName,
      lifecycleStage: c.lifecycleStage,
      leadStatus: c.leadStatus,
      ownerExternalId: c.ownerExternalId,
      externalCreatedAt: c.externalCreatedAt,
      externalUpdatedAt: c.externalUpdatedAt,
      dateEnteredSalesQualifiedLead: c.dateEnteredSalesQualifiedLead,
      dateEnteredMarketingQualifiedLead: c.dateEnteredMarketingQualifiedLead,
      crmLastActivityAt: c.crmLastActivityAt,
      crmLastContactedAt: c.crmLastContactedAt,
      nextActivityAt: c.nextActivityAt,
      archivedAt: null,
      ...(seenAt ? { lastSeenFullSyncAt: seenAt } : {}),
    };
    const r = await tx.crmContact.upsert({
      where: { organizationId_integrationId_externalId: { ...scope, externalId: c.externalId } },
      create: { ...scope, externalId: c.externalId, ...data },
      update: data,
      select: { id: true },
    });
    ids.set(c.externalId, r.id);
  }
  return ids;
}

async function upsertCompanies(tx: Tx, scope: { organizationId: string; integrationId: string }, rows: readonly CrmCompanyRecord[]) {
  const ids = new Map<string, string>();
  for (const c of rows) {
    const data = { name: c.name, domain: c.domain, externalUpdatedAt: c.externalUpdatedAt, archivedAt: null };
    const r = await tx.crmCompany.upsert({
      where: { organizationId_integrationId_externalId: { ...scope, externalId: c.externalId } },
      create: { ...scope, externalId: c.externalId, ...data },
      update: data,
      select: { id: true },
    });
    ids.set(c.externalId, r.id);
  }
  return ids;
}

/** Fetch associations + associated records for one page of deals and persist it. Idempotent. */
async function persistDeals(ctx: SyncCtx, source: CrmSource, deals: readonly CrmDealRecord[], seenAt: Date | null): Promise<void> {
  if (deals.length === 0) return;
  const needAssoc = deals.filter((d) => d.contactIds === null || d.companyIds === null).map((d) => d.externalId);
  const [contactAssoc, companyAssoc] = needAssoc.length
    ? await Promise.all([source.dealAssociations(needAssoc, "contacts"), source.dealAssociations(needAssoc, "companies")])
    : [new Map<string, readonly string[]>(), new Map<string, readonly string[]>()];
  const contactIdsOf = (d: CrmDealRecord) => d.contactIds ?? contactAssoc.get(d.externalId) ?? [];
  const companyIdsOf = (d: CrmDealRecord) => d.companyIds ?? companyAssoc.get(d.externalId) ?? [];

  const contacts = await source.getContacts([...new Set(deals.flatMap(contactIdsOf))]);
  const companies = await source.getCompanies([...new Set(deals.flatMap(companyIdsOf))]);

  const { auth, integrationId } = ctx;
  const scope = { organizationId: auth.organizationId, integrationId };
  await withOrgScope(auth, async (tx) => {
    const contactIds = await upsertContacts(tx, scope, contacts, seenAt);
    const companyIds = await upsertCompanies(tx, scope, companies);
    for (const d of deals) {
      const stage = d.pipelineExternalId && d.stageExternalId ? ctx.stages.get(`${d.pipelineExternalId}/${d.stageExternalId}`) : undefined;
      // Open/closed: the stage's metadata when it states it; else HubSpot's own
      // calculated hs_is_closed for the deal; else UNKNOWN (null) — never guessed.
      const stageClosed = stage?.isClosed ?? null;
      const isClosed = stageClosed ?? d.isClosed ?? null;
      if (!stage) ctx.counters.dealsWithUnknownStage++;
      if (isClosed === null) ctx.counters.dealsClosedStatusUnknown++;
      const data = {
        name: d.name,
        amount: d.amount,
        currency: d.currency,
        pipelineExternalId: d.pipelineExternalId,
        stageExternalId: d.stageExternalId,
        ownerExternalId: d.ownerExternalId,
        isClosed,
        isWon: stageClosed !== null ? stage!.isWon : d.isWon,
        closeDate: d.closeDate,
        externalCreatedAt: d.externalCreatedAt,
        externalUpdatedAt: d.externalUpdatedAt,
        crmLastActivityAt: d.crmLastActivityAt,
        crmLastContactedAt: d.crmLastContactedAt,
        nextActivityAt: d.nextActivityAt,
        archivedAt: null,
        ...(seenAt ? { lastSeenFullSyncAt: seenAt } : {}),
      };
      const row = await tx.crmDeal.upsert({
        where: { organizationId_integrationId_externalId: { ...scope, externalId: d.externalId } },
        create: { ...scope, externalId: d.externalId, ...data },
        update: data,
        select: { id: true },
      });
      await tx.crmDealContact.deleteMany({ where: { organizationId: auth.organizationId, dealId: row.id } });
      await tx.crmDealCompany.deleteMany({ where: { organizationId: auth.organizationId, dealId: row.id } });
      const cIds = contactIdsOf(d).flatMap((x) => (contactIds.has(x) ? [contactIds.get(x)!] : []));
      const coIds = companyIdsOf(d).flatMap((x) => (companyIds.has(x) ? [companyIds.get(x)!] : []));
      if (cIds.length) {
        await tx.crmDealContact.createMany({
          data: cIds.map((contactId) => ({ organizationId: auth.organizationId, dealId: row.id, contactId })),
          skipDuplicates: true,
        });
      }
      if (coIds.length) {
        await tx.crmDealCompany.createMany({
          data: coIds.map((companyId) => ({ organizationId: auth.organizationId, dealId: row.id, companyId })),
          skipDuplicates: true,
        });
      }
    }
  });
  ctx.counters.dealsUpserted += deals.length;
  for (const c of contacts) {
    if (!ctx.seenContactExternalIds.has(c.externalId)) {
      ctx.seenContactExternalIds.add(c.externalId);
      ctx.counters.contactsUpserted++;
    }
  }
  ctx.counters.companiesUpserted += companies.length;
}

type StepResult = { complete: boolean };

async function fullPass(ctx: SyncCtx, source: CrmSource, existing: FullPassCursor | null): Promise<StepResult> {
  const passStartedAt = existing ? new Date(existing.passStartedAt) : new Date(ctx.clock.now());
  let phase: "deals" | "contacts" = existing?.phase ?? "deals";
  let after = existing?.after ?? undefined;
  if (!existing) {
    await checkpoint(ctx, { backfillCursor: JSON.stringify({ v: 1, phase: "deals", after: null, passStartedAt: passStartedAt.toISOString() }) });
  }

  if (phase === "deals") {
    for (;;) {
      if (budgetExhausted(ctx)) return { complete: false };
      const page = await source.listDeals(after);
      await persistDeals(ctx, source, page.items, passStartedAt);
      after = page.next ?? undefined;
      if (!after) break;
      await checkpoint(ctx, { backfillCursor: JSON.stringify({ v: 1, phase: "deals", after, passStartedAt: passStartedAt.toISOString() }) });
    }
    // Reconcile every CRM contact as well, including contacts not tied to a deal.
    phase = "contacts";
    after = undefined;
    await checkpoint(ctx, { backfillCursor: JSON.stringify({ v: 1, phase, after: null, passStartedAt: passStartedAt.toISOString() }) });
  }

  if (phase === "contacts") {
    for (;;) {
      if (budgetExhausted(ctx)) return { complete: false };
      const page = await source.listContacts(after);
      await withOrgScope(ctx.auth, async (tx) => {
        await upsertContacts(tx, { organizationId: ctx.auth.organizationId, integrationId: ctx.integrationId }, page.items, passStartedAt);
      });
      for (const c of page.items) {
        if (!ctx.seenContactExternalIds.has(c.externalId)) {
          ctx.seenContactExternalIds.add(c.externalId);
          ctx.counters.contactsUpserted++;
        }
      }
      after = page.next ?? undefined;
      if (!after) break;
      await checkpoint(ctx, { backfillCursor: JSON.stringify({ v: 1, phase: "contacts", after, passStartedAt: passStartedAt.toISOString() }) });
    }
  }

  // Archive only after complete passes over both deals and contacts.
  const { auth, integrationId } = ctx;
  ctx.counters.dealsArchived += await withOrgScope(auth, (tx) => tx.$executeRaw`
    UPDATE crm_deals SET archived_at = now(), updated_at = now()
     WHERE organization_id = ${auth.organizationId}::uuid AND integration_id = ${integrationId}::uuid
       AND archived_at IS NULL
       AND (last_seen_full_sync_at IS NULL OR last_seen_full_sync_at < ${passStartedAt})`);
  ctx.counters.contactsArchived += await withOrgScope(auth, (tx) => tx.$executeRaw`
    UPDATE crm_contacts SET archived_at = now(), updated_at = now()
     WHERE organization_id = ${auth.organizationId}::uuid AND integration_id = ${integrationId}::uuid
       AND archived_at IS NULL
       AND (last_seen_full_sync_at IS NULL OR last_seen_full_sync_at < ${passStartedAt})`);
  const n = await withOrgScope(auth, (tx) => tx.$executeRaw`
    UPDATE integrations
       SET full_synced_at = ${passStartedAt}, backfill_cursor = NULL,
           sync_cursor = ${JSON.stringify({ v: 1, watermark: passStartedAt.getTime() - WATERMARK_OVERLAP_MS })},
           updated_at = now()
     WHERE id = ${integrationId}::uuid AND sync_lease_expires_at = ${ctx.lease}`);
  if (n === 0) throw new LeaseLostError();
  return { complete: true };
}

async function incremental(ctx: SyncCtx, source: CrmSource, cursor: WatermarkCursor): Promise<StepResult> {
  let since = cursor.watermark;
  let after: string | undefined;
  let maxSeen = since;
  for (;;) {
    if (budgetExhausted(ctx)) return { complete: false };
    const page = await source.searchDealsModifiedSince(since, after);
    await persistDeals(ctx, source, page.items, null);
    for (const d of page.items) if (d.externalUpdatedAt) maxSeen = Math.max(maxSeen, d.externalUpdatedAt.getTime());
    await checkpoint(ctx, { syncCursor: JSON.stringify({ v: 2, watermark: maxSeen }) });
    if (page.capped) {
      // 10,000-result window exhausted: restart the query from the newest timestamp seen.
      since = maxSeen > since ? maxSeen : since + 1;
      after = undefined;
      log.info("hubspot.search_reanchored", { integrationId: ctx.integrationId, since });
      continue;
    }
    if (!page.next) return { complete: true };
    after = page.next;
  }
}

// ─── Public entry point ─────────────────────────────────────────────────────

function safeFailure(err: unknown): { code: string; message: string; appError: AppError | null } {
  if (err instanceof CrmAuthorizationRevokedError) {
    return {
      code: "reauth_required",
      message: "HubSpot access was revoked or is missing permissions. An admin must reconnect HubSpot.",
      appError: new PolicyViolationError("HubSpot access was revoked or is missing permissions. Reconnect HubSpot."),
    };
  }
  if (err instanceof CrmError && err.kind === "rate_limited") {
    return { code: "rate_limited", message: "HubSpot rate limit reached. Progress was saved; sync will resume later.", appError: new UpstreamServiceError("HubSpot rate limit reached; progress saved, try again later") };
  }
  if (err instanceof CrmError && err.kind === "forbidden") {
    return { code: "hubspot_access_denied", message: "HubSpot denied access. Progress was saved; sync will retry later.", appError: new UpstreamServiceError("HubSpot denied access; try again later") };
  }
  if (err instanceof CrmError) {
    return { code: err.kind, message: "HubSpot is temporarily unavailable. Progress was saved; sync will resume later.", appError: new UpstreamServiceError("HubSpot is temporarily unavailable; try again later") };
  }
  if (err instanceof LeaseLostError) {
    return { code: "lease_lost", message: "Sync was interrupted and will resume on the next run.", appError: new ConflictError("Sync was interrupted; try again") };
  }
  if (err instanceof AppError) return { code: err.code, message: "Sync failed. It will be retried.", appError: err };
  return { code: "internal_error", message: "Sync failed unexpectedly. It will be retried.", appError: null };
}

export async function syncHubSpot(auth: AuthContext, opts: HubSpotSyncOptions): Promise<HubSpotSyncResult> {
  requireRole(auth, "ADMIN");
  const actor = opts.trigger === "cron" ? "SYSTEM" : "USER";
  const env = getEnv();
  const clock = opts.clock ?? realClock;
  const integration = await findHubSpotIntegration(auth);
  if (!integration || integration.status === "PENDING" || integration.status === "DISCONNECTED") {
    throw new NotFoundError("HubSpot is not connected");
  }
  if (integration.status === "REAUTH_REQUIRED") throw new PolicyViolationError("HubSpot needs to be reconnected");
  if (integration.status !== "CONNECTED") throw new PolicyViolationError("HubSpot is not connected");

  const lease = await claimLease(auth, integration.id);
  if (!lease) throw new ConflictError("A HubSpot sync is already running for this organization");

  const started = clock.now();
  const fullCursor = parseFullPass(integration.backfillCursor);
  const watermark = parseWatermark(integration.syncCursor);
  const fullDue =
    opts.forceFull ||
    fullCursor !== null ||
    watermark === null ||
    watermark.v !== 2 ||
    !integration.fullSyncedAt ||
    started - integration.fullSyncedAt.getTime() > FULL_RECONCILE_EVERY_MS;
  const mode: HubSpotSyncMode = fullDue ? "full" : "incremental";
  const resumed = fullCursor !== null;
  const ctx: SyncCtx = {
    auth,
    integrationId: integration.id,
    lease,
    clock,
    deadlineAt: opts.deadlineAt ?? started + env.HUBSPOT_SYNC_RUN_BUDGET_SECONDS * 1000,
    stages: new Map(),
    pipelineMetadata: "OK",
    seenContactExternalIds: new Set<string>(),
    counters: {
      dealsUpserted: 0,
      dealsArchived: 0,
      contactsUpserted: 0,
      contactsArchived: 0,
      companiesUpserted: 0,
      ownersUpserted: 0,
      stagesUpserted: 0,
      ownersAutoMapped: 0,
      dealsWithUnknownStage: 0,
      dealsClosedStatusUnknown: 0,
    },
  };
  const logBase = { organizationId: auth.organizationId, integrationId: integration.id, trigger: opts.trigger };
  await withOrgScope(auth, (tx) =>
    recordAudit(tx, auth, { event: "hubspot.sync_started", entityType: "integration", entityId: integration.id, metadata: { trigger: opts.trigger, mode, resumed } }, { actor }),
  );
  log.info("hubspot.sync_started", { ...logBase, mode, resumed });

  try {
    const source = opts.source ?? createHubSpotCrmSource(auth, integration.id, { actor, clock });
    let step: StepResult;
    try {
      await syncOwnersAndStages(ctx, source);
      step = fullDue ? await fullPass(ctx, source, opts.forceFull && !fullCursor ? null : fullCursor) : await incremental(ctx, source, watermark!);
    } catch (err) {
      // Daily allowance reserve reached: stop cleanly; progress is checkpointed.
      if (!(err instanceof CrmError && err.kind === "daily_limit")) throw err;
      log.warn("hubspot.daily_reserve_reached", logBase);
      step = { complete: false };
    }

    const committed = await withOrgScope(auth, async (tx) => {
      const n = step.complete
        ? await tx.$executeRaw`
            UPDATE integrations SET last_synced_at = now(), last_error = NULL, sync_lease_expires_at = NULL, updated_at = now()
             WHERE id = ${integration.id}::uuid AND sync_lease_expires_at = ${ctx.lease}`
        : await tx.$executeRaw`
            UPDATE integrations SET last_error = NULL, sync_lease_expires_at = NULL, updated_at = now()
             WHERE id = ${integration.id}::uuid AND sync_lease_expires_at = ${ctx.lease}`;
      if (n === 0) return false;
      await recordAudit(tx, auth, {
        event: step.complete ? "hubspot.sync_completed" : "hubspot.sync_partial",
        entityType: "integration",
        entityId: integration.id,
        metadata: { trigger: opts.trigger, mode, resumed, ...ctx.counters, pipelineMetadata: ctx.pipelineMetadata },
      }, { actor });
      return true;
    });
    if (!committed) throw new LeaseLostError();

    const result: HubSpotSyncResult = {
      integrationId: integration.id,
      mode,
      outcome: step.complete ? "completed" : "partial",
      trigger: opts.trigger,
      resumed,
      ...ctx.counters,
      pipelineMetadata: ctx.pipelineMetadata,
      durationMs: clock.now() - started,
    };
    log.info(step.complete ? "hubspot.sync_completed" : "hubspot.sync_partial", { ...logBase, ...result });
    return result;
  } catch (err) {
    const failure = safeFailure(err);
    await withOrgScope(auth, async (tx) => {
      await tx.$executeRaw`
        UPDATE integrations SET sync_lease_expires_at = NULL, last_error = ${failure.message}, updated_at = now()
         WHERE id = ${integration.id}::uuid AND sync_lease_expires_at = ${ctx.lease}`;
      await recordAudit(tx, auth, {
        event: "hubspot.sync_failed",
        entityType: "integration",
        entityId: integration.id,
        metadata: { trigger: opts.trigger, mode, errorCode: failure.code, ...(err instanceof CrmError ? err.diagnostics : {}), ...ctx.counters },
      }, { actor });
    }).catch(() => undefined);
    if (err instanceof CrmAuthorizationRevokedError) {
      await markHubSpotReauthRequired(auth, integration.id, { actor }).catch(() => undefined);
    }
    log.error("hubspot.sync_failed", {
      ...logBase,
      mode,
      errorCode: failure.code,
      errorName: err instanceof Error ? err.name : typeof err,
      ...(err instanceof CrmError ? err.diagnostics : {}),
      ...ctx.counters,
      durationMs: clock.now() - started,
    });
    throw failure.appError ?? err;
  }
}
