import "server-only";

import { randomUUID } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import { type AuthContext, requireRole } from "@/domain/auth/auth-context";
import { determineDirection } from "@/domain/email/direction";
import {
  MailboxAuthorizationRevokedError,
  MailboxCursorExpiredError,
  MailboxError,
  type MailboxSource,
  type NormalizedEmailMessage,
} from "@/domain/email/types";
import { getEnv } from "@/lib/env";
import { AppError, ConflictError, NotFoundError, PolicyViolationError, UpstreamServiceError } from "@/lib/errors";
import { log } from "@/lib/log";
import { recordAudit } from "@/server/audit/audit-log";
import { type Tx, withOrgScope } from "@/server/db/org-scope";

import { type Clock, realClock } from "./gmail.client";
import { createGmailMailboxSource } from "./gmail.adapter";
import { findOwnGmailIntegration } from "./gmail-connection.service";

/**
 * GmailSyncService
 *
 *   claim lease ─▶ syncCursor? ──no──▶ INITIAL BACKFILL (resumable, multi-run)
 *                     │yes              · backfillCursor = historyId captured when the
 *                     ▼                   backfill FIRST started (kept across runs)
 *                INCREMENTAL           · skips messages already stored → resumes
 *                (History API)         · on completion: syncCursor ← backfillCursor
 *                     │ cursor expired?
 *                     ▼
 *                RECOVERY: reset to a fresh initial backfill
 *
 *   Every run is time-boxed (GMAIL_SYNC_RUN_BUDGET_SECONDS). A run that stops
 *   because its budget ran out ends as PARTIAL — not a failure: the lease is
 *   released, no error is recorded, and the next run (cron / "Sync now")
 *   continues. The sync checkpoint only ever advances after a COMPLETE run.
 *
 *   Gmail calls are paced to the per-user quota (QuotaPacer) with 2 workers;
 *   rate limits back off exponentially; a fatal error stops sibling workers.
 *   All writes are idempotent and run under the owner's AuthContext + RLS.
 *   Message content is never logged or audited.
 */
export const LEASE_SECONDS = 10 * 60;
export const BATCH_SIZE = 100;
export const FETCH_CONCURRENCY = 2;

export type SyncType = "initial" | "incremental" | "recovery";
export type SyncOutcome = "completed" | "partial";

export interface GmailSyncResult {
  integrationId: string;
  syncType: SyncType;
  outcome: SyncOutcome;
  /** True when this run continued a backfill started by an earlier run. */
  resumed: boolean;
  trigger: "manual" | "cron" | "connect";
  messagesUpserted: number;
  messagesDeleted: number;
  /** Listed messages skipped because they were already stored (resume). */
  alreadySynced: number;
  threadsTouched: number;
  skipped: number;
  cursorBefore: string | null;
  /** Committed checkpoint; null when the run was partial (nothing committed). */
  cursorAfter: string | null;
  durationMs: number;
}

export interface GmailSyncOptions {
  trigger: "manual" | "cron" | "connect";
  lookbackDays?: number;
  now?: Date;
  /** Injected in tests; defaults to the Gmail adapter. */
  source?: MailboxSource;
  /** Time source for pacing, backoff and the run deadline (virtual in tests). */
  clock?: Clock;
  /** Absolute deadline (clock ms). Defaults to now + GMAIL_SYNC_RUN_BUDGET_SECONDS. */
  deadlineAt?: number;
  /** Cap on message fetches this run (tests / operational safety). */
  maxMessageFetches?: number;
  /** Override pacing for this run (quota units per second). */
  unitsPerSecond?: number;
}

class LeaseLostError extends Error {
  constructor() {
    super("Sync lease expired or was taken over");
    this.name = "LeaseLostError";
  }
}

interface SyncCtx {
  auth: AuthContext;
  integrationId: string;
  lease: Date;
  mailboxAddress: string;
  clock: Clock;
  deadlineAt: number;
  fetchesRemaining: number;
  counters: { upserted: number; deleted: number; skipped: number; alreadySynced: number; threads: Set<string> };
}

function budgetExhausted(ctx: SyncCtx): boolean {
  return ctx.fetchesRemaining <= 0 || ctx.clock.now() >= ctx.deadlineAt;
}

// ─── Lease (single-row compare-and-set; stale leases expire) ────────────────

async function claimLease(auth: AuthContext, integrationId: string): Promise<Date | null> {
  return withOrgScope(auth, async (tx) => {
    const rows = await tx.$queryRaw<{ lease: Date }[]>`
      UPDATE integrations
         SET sync_lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS}),
             last_sync_attempt_at = now(),
             updated_at = now()
       WHERE id = ${integrationId}::uuid
         AND organization_id = ${auth.organizationId}::uuid
         AND owner_user_id = ${auth.userId}::uuid
         AND status = 'CONNECTED'
         AND (sync_lease_expires_at IS NULL OR sync_lease_expires_at < now())
      RETURNING sync_lease_expires_at AS lease`;
    return rows[0]?.lease ?? null;
  });
}

async function extendLease(ctx: SyncCtx): Promise<void> {
  const rows = await withOrgScope(ctx.auth, (tx) => tx.$queryRaw<{ lease: Date }[]>`
    UPDATE integrations
       SET sync_lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS})
     WHERE id = ${ctx.integrationId}::uuid AND sync_lease_expires_at = ${ctx.lease}
    RETURNING sync_lease_expires_at AS lease`);
  if (!rows[0]) throw new LeaseLostError();
  ctx.lease = rows[0].lease;
}

// ─── Persistence (idempotent) ───────────────────────────────────────────────

async function recomputeThreads(tx: Tx, threadIds: string[]): Promise<void> {
  if (threadIds.length === 0) return;
  await tx.$executeRaw`
    UPDATE email_threads t
       SET message_count = s.cnt,
           first_message_at = s.first_at,
           last_message_at = s.last_at,
           subject = coalesce(s.subject, t.subject),
           updated_at = now()
      FROM (
        SELECT thread_id,
               count(*)::int AS cnt,
               min(received_at) AS first_at,
               max(received_at) AS last_at,
               (array_agg(subject ORDER BY received_at ASC) FILTER (WHERE subject IS NOT NULL))[1] AS subject
          FROM email_messages
         WHERE thread_id = ANY(${threadIds}::uuid[])
         GROUP BY thread_id
      ) s
     WHERE t.id = s.thread_id`;
  await tx.$executeRaw`
    DELETE FROM email_threads t
     WHERE t.id = ANY(${threadIds}::uuid[])
       AND NOT EXISTS (SELECT 1 FROM email_messages m WHERE m.thread_id = t.id)`;
}

function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
}

/** Upsert one batch of normalized messages and their threads. Safe to repeat. */
async function persistBatch(ctx: SyncCtx, messages: NormalizedEmailMessage[]): Promise<void> {
  if (messages.length === 0) return;
  const { auth, integrationId } = ctx;
  const owner = { organizationId: auth.organizationId, mailboxUserId: auth.userId, integrationId };

  await withOrgScope(auth, async (tx) => {
    // Threads: create missing, then resolve internal ids.
    const extThreadIds = [...new Set(messages.map((m) => m.externalThreadId))];
    const known = await tx.emailThread.findMany({
      where: { ...owner, externalThreadId: { in: extThreadIds } },
      select: { id: true, externalThreadId: true },
    });
    const threadIdByExt = new Map(known.map((t) => [t.externalThreadId, t.id]));
    const missing = extThreadIds.filter((id) => !threadIdByExt.has(id));
    if (missing.length) {
      await tx.emailThread.createMany({
        data: missing.map((ext) => {
          const first = messages.find((m) => m.externalThreadId === ext)!;
          return {
            id: randomUUID(),
            ...owner,
            externalThreadId: ext,
            subject: first.subject,
            firstMessageAt: first.receivedAt,
            lastMessageAt: first.receivedAt,
          };
        }),
        skipDuplicates: true,
      });
      const created = await tx.emailThread.findMany({
        where: { ...owner, externalThreadId: { in: missing } },
        select: { id: true, externalThreadId: true },
      });
      for (const t of created) threadIdByExt.set(t.externalThreadId, t.id);
    }

    // Messages: insert new; refresh labels on existing (content is immutable in Gmail).
    const existing = await tx.emailMessage.findMany({
      where: { ...owner, externalMessageId: { in: messages.map((m) => m.externalMessageId) } },
      select: { id: true, externalMessageId: true, labels: true },
    });
    const existingByExt = new Map(existing.map((m) => [m.externalMessageId, m]));
    const seen = new Set<string>();
    const fresh: Array<NormalizedEmailMessage & { id: string }> = [];
    for (const m of messages) {
      if (seen.has(m.externalMessageId)) continue;
      seen.add(m.externalMessageId);
      const prior = existingByExt.get(m.externalMessageId);
      if (!prior) fresh.push({ ...m, id: randomUUID() });
      else if (!sameLabels(prior.labels, m.labels)) {
        await tx.emailMessage.update({ where: { id: prior.id }, data: { labels: [...m.labels] } });
      }
    }

    if (fresh.length) {
      await tx.emailMessage.createMany({
        data: fresh.map((m) => ({
          id: m.id,
          ...owner,
          threadId: threadIdByExt.get(m.externalThreadId)!,
          externalMessageId: m.externalMessageId,
          externalThreadId: m.externalThreadId,
          fromEmail: m.from?.email ?? null,
          fromName: m.from?.name ?? null,
          subject: m.subject,
          snippet: m.snippet,
          bodyText: m.bodyText,
          bodyTruncated: m.bodyTruncated,
          sentAt: m.sentAt,
          receivedAt: m.receivedAt,
          direction: determineDirection(m.from, ctx.mailboxAddress, m.labels),
          labels: [...m.labels],
          headers: m.metadata as unknown as Prisma.InputJsonValue,
        })),
        skipDuplicates: true,
      });
      const recipients = fresh.flatMap((m) => {
        const rows: Prisma.EmailMessageRecipientCreateManyInput[] = [];
        const add = (kind: "TO" | "CC" | "BCC", list: NormalizedEmailMessage["to"]) => {
          for (const p of list) {
            rows.push({
              organizationId: auth.organizationId,
              mailboxUserId: auth.userId,
              messageId: m.id,
              kind,
              email: p.email,
              name: p.name,
            });
          }
        };
        add("TO", m.to);
        add("CC", m.cc);
        add("BCC", m.bcc);
        return rows;
      });
      if (recipients.length) await tx.emailMessageRecipient.createMany({ data: recipients, skipDuplicates: true });
    }

    const touched = [...new Set(messages.map((m) => threadIdByExt.get(m.externalThreadId)!))];
    await recomputeThreads(tx, touched);
    for (const id of touched) ctx.counters.threads.add(id);
    ctx.counters.upserted += seen.size;
  });
}

async function deleteMessages(ctx: SyncCtx, externalIds: string[]): Promise<void> {
  if (externalIds.length === 0) return;
  const { auth, integrationId } = ctx;
  await withOrgScope(auth, async (tx) => {
    const where = {
      organizationId: auth.organizationId,
      mailboxUserId: auth.userId,
      integrationId,
      externalMessageId: { in: externalIds },
    };
    const rows = await tx.emailMessage.findMany({ where, select: { threadId: true } });
    if (rows.length === 0) return;
    const { count } = await tx.emailMessage.deleteMany({ where });
    await recomputeThreads(tx, [...new Set(rows.map((r) => r.threadId))]);
    ctx.counters.deleted += count;
  });
}

// ─── Fetch helpers ──────────────────────────────────────────────────────────

/**
 * Fetch messages with bounded concurrency. Per-message bad responses are
 * skipped, not fatal. On a fatal error, sibling workers stop picking up new
 * work, all in-flight requests settle, and the first error is rethrown — so
 * nothing keeps calling Gmail after the run has failed.
 */
async function fetchMessages(
  ctx: SyncCtx,
  source: MailboxSource,
  ids: readonly string[],
): Promise<{ found: NormalizedEmailMessage[]; gone: string[]; skipped: number; attempted: number }> {
  const found: NormalizedEmailMessage[] = [];
  const gone: string[] = [];
  let skipped = 0;
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    // Stop taking new ids once the run deadline passes; unfetched ids are
    // simply not stored and get picked up by the next run (resume).
    while (!failure && next < ids.length && ctx.clock.now() < ctx.deadlineAt) {
      const id = ids[next++]!;
      try {
        const msg = await source.getMessage(id);
        if (msg) found.push(msg);
        else gone.push(id);
      } catch (err) {
        if (err instanceof MailboxError && err.kind === "invalid_response") skipped++;
        else failure ??= { error: err };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, ids.length) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
  return { found, gone, skipped, attempted: Math.min(next, ids.length) };
}

/** Returns false if the run budget ran out before every id was processed. */
async function processIdsInBatches(
  ctx: SyncCtx,
  source: MailboxSource,
  ids: readonly string[],
  goneMeansDeleted: boolean,
): Promise<boolean> {
  for (let i = 0; i < ids.length; ) {
    if (budgetExhausted(ctx)) return false;
    const take = Math.min(BATCH_SIZE, ctx.fetchesRemaining, ids.length - i);
    const slice = ids.slice(i, i + take);
    i += take;
    const { found, gone, skipped, attempted } = await fetchMessages(ctx, source, slice);
    ctx.fetchesRemaining -= attempted;
    ctx.counters.skipped += skipped + (goneMeansDeleted ? 0 : gone.length);
    await persistBatch(ctx, found);
    if (goneMeansDeleted) await deleteMessages(ctx, gone);
    await extendLease(ctx);
    if (attempted < slice.length) return false; // deadline reached mid-batch
  }
  return true;
}

/** Ids from `ids` not yet stored for this mailbox (one indexed query). */
async function filterUnsynced(ctx: SyncCtx, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const stored = await withOrgScope(ctx.auth, (tx) =>
    tx.emailMessage.findMany({
      where: {
        organizationId: ctx.auth.organizationId,
        mailboxUserId: ctx.auth.userId,
        integrationId: ctx.integrationId,
        externalMessageId: { in: [...ids] },
      },
      select: { externalMessageId: true },
    }),
  );
  const have = new Set(stored.map((m) => m.externalMessageId));
  ctx.counters.alreadySynced += have.size;
  return ids.filter((id) => !have.has(id));
}

/** Compare-and-set a column while we still hold the lease. */
async function setBackfillCursor(ctx: SyncCtx, cursor: string | null): Promise<void> {
  const n = await withOrgScope(ctx.auth, (tx) => tx.$executeRaw`
    UPDATE integrations SET backfill_cursor = ${cursor}, updated_at = now()
     WHERE id = ${ctx.integrationId}::uuid AND sync_lease_expires_at = ${ctx.lease}`);
  if (n === 0) throw new LeaseLostError();
}

// ─── Sync strategies ────────────────────────────────────────────────────────

type StepResult = { complete: true; cursor: string } | { complete: false };

/**
 * Initial backfill, resumable across runs. The checkpoint is the historyId
 * from when the backfill FIRST started (persisted as backfill_cursor), so
 * deletions/label changes during a multi-run backfill are replayed later.
 * Already-stored messages are not fetched again.
 */
async function backfill(
  ctx: SyncCtx,
  source: MailboxSource,
  since: Date,
  existingBackfillCursor: string | null,
): Promise<StepResult> {
  const { address, cursor } = await source.getMailbox();
  ctx.mailboxAddress = address;
  const startCursor = existingBackfillCursor ?? cursor;
  if (!existingBackfillCursor) await setBackfillCursor(ctx, startCursor);

  let pageToken: string | undefined;
  do {
    if (budgetExhausted(ctx)) return { complete: false };
    const page = await source.listMessageIdsSince(since, pageToken);
    const missing = await filterUnsynced(ctx, page.ids);
    if (!(await processIdsInBatches(ctx, source, missing, false))) return { complete: false };
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);
  return { complete: true, cursor: startCursor };
}

/**
 * Incremental sync from the stored cursor. If the budget runs out the cursor
 * is NOT advanced; the next run replays from the same cursor (idempotent).
 */
async function incremental(ctx: SyncCtx, source: MailboxSource, cursor: string): Promise<StepResult> {
  const { address } = await source.getMailbox();
  ctx.mailboxAddress = address;
  let pageToken: string | undefined;
  let latest = cursor;
  do {
    if (budgetExhausted(ctx)) return { complete: false };
    const page = await source.listChangesSince(cursor, pageToken);
    await deleteMessages(ctx, [...page.deleted]);
    // A changed message that is now gone or excluded (trashed, spam) is removed.
    if (!(await processIdsInBatches(ctx, source, page.changed, true))) return { complete: false };
    latest = page.cursor;
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);
  return { complete: true, cursor: latest };
}

// ─── Public entry point ─────────────────────────────────────────────────────

function safeFailure(err: unknown): { code: string; message: string; appError: AppError | null } {
  if (err instanceof MailboxAuthorizationRevokedError) {
    return {
      code: "reauth_required",
      message: "Google access was revoked or expired. Reconnect Gmail to resume syncing.",
      appError: new PolicyViolationError("Gmail access was revoked or expired. Reconnect Gmail."),
    };
  }
  if (err instanceof MailboxError && err.kind === "rate_limited") {
    return {
      code: "rate_limited",
      message: "Gmail rate limit reached. Progress was saved; sync will resume later.",
      appError: new UpstreamServiceError("Gmail rate limit reached; progress saved, try again later"),
    };
  }
  if (err instanceof MailboxError) {
    return {
      code: err.kind,
      message: "Gmail is temporarily unavailable. Progress was saved; sync will resume later.",
      appError: new UpstreamServiceError("Gmail is temporarily unavailable; try again later"),
    };
  }
  if (err instanceof LeaseLostError) {
    return { code: "lease_lost", message: "Sync was interrupted and will resume on the next run.", appError: new ConflictError("Sync was interrupted; try again") };
  }
  if (err instanceof AppError) return { code: err.code, message: "Sync failed. It will be retried.", appError: err };
  return { code: "internal_error", message: "Sync failed unexpectedly. It will be retried.", appError: null };
}

export async function syncGmailMailbox(auth: AuthContext, opts: GmailSyncOptions): Promise<GmailSyncResult> {
  requireRole(auth, "MEMBER");
  const actor = opts.trigger === "cron" ? "SYSTEM" : "USER";
  const env = getEnv();
  const clock = opts.clock ?? realClock;
  const integration = await findOwnGmailIntegration(auth);
  if (!integration) throw new NotFoundError("Gmail is not connected");
  if (integration.status === "REAUTH_REQUIRED") throw new PolicyViolationError("Gmail needs to be reconnected");
  if (integration.status !== "CONNECTED") throw new PolicyViolationError("Gmail is not connected");

  const lease = await claimLease(auth, integration.id);
  if (!lease) throw new ConflictError("A Gmail sync is already running for this mailbox");

  const started = clock.now();
  const cursorBefore = integration.syncCursor;
  let backfillCursor = integration.backfillCursor;
  const resumed = !cursorBefore && backfillCursor !== null;
  const logBase = {
    organizationId: auth.organizationId,
    mailboxUserId: auth.userId,
    integrationId: integration.id,
    trigger: opts.trigger,
  };
  const ctx: SyncCtx = {
    auth,
    integrationId: integration.id,
    lease,
    mailboxAddress: integration.externalAccountId ?? "",
    clock,
    deadlineAt: opts.deadlineAt ?? started + env.GMAIL_SYNC_RUN_BUDGET_SECONDS * 1000,
    fetchesRemaining: opts.maxMessageFetches ?? Number.POSITIVE_INFINITY,
    counters: { upserted: 0, deleted: 0, skipped: 0, alreadySynced: 0, threads: new Set() },
  };
  let syncType: SyncType = cursorBefore ? "incremental" : "initial";
  await withOrgScope(auth, (tx) =>
    recordAudit(tx, auth, { event: "gmail.sync_started", entityType: "integration", entityId: integration.id, metadata: { trigger: opts.trigger, syncType, resumed } }, { actor }),
  );
  log.info("gmail.sync_started", { ...logBase, syncType, resumed, cursorBefore, backfillCursor });

  const counts = () => ({
    messagesUpserted: ctx.counters.upserted,
    messagesDeleted: ctx.counters.deleted,
    alreadySynced: ctx.counters.alreadySynced,
    threadsTouched: ctx.counters.threads.size,
    skipped: ctx.counters.skipped,
  });

  try {
    const source =
      opts.source ?? createGmailMailboxSource(auth, integration.id, { actor, clock, unitsPerSecond: opts.unitsPerSecond });
    const lookbackDays = opts.lookbackDays ?? env.GMAIL_SYNC_LOOKBACK_DAYS;
    const since = new Date((opts.now ?? new Date()).getTime() - lookbackDays * 86_400_000);

    let step: StepResult;
    if (!cursorBefore) {
      step = await backfill(ctx, source, since, backfillCursor);
    } else {
      try {
        step = await incremental(ctx, source, cursorBefore);
      } catch (err) {
        if (!(err instanceof MailboxCursorExpiredError)) throw err;
        // Gmail no longer has history for our cursor. Do not pretend the
        // incremental sync succeeded: drop the checkpoint, record it, and
        // rebuild a bounded baseline (which may itself span several runs).
        syncType = "recovery";
        await withOrgScope(auth, async (tx) => {
          const n = await tx.$executeRaw`
            UPDATE integrations
               SET sync_cursor = NULL, backfill_cursor = NULL,
                   last_error = 'Gmail history expired; running a recovery sync.', updated_at = now()
             WHERE id = ${integration.id}::uuid AND sync_lease_expires_at = ${ctx.lease}`;
          if (n === 0) throw new LeaseLostError();
          await recordAudit(tx, auth, { event: "gmail.resync_required", entityType: "integration", entityId: integration.id, metadata: { cursorBefore } }, { actor });
        });
        log.warn("gmail.history_expired", { ...logBase, cursorBefore, ...err.diagnostics });
        backfillCursor = null;
        step = await backfill(ctx, source, since, null);
      }
    }

    const outcome: SyncOutcome = step.complete ? "completed" : "partial";
    const cursorAfter = step.complete ? step.cursor : null;

    // Commit only while we still hold the lease. A partial run releases the
    // lease and clears errors but leaves the sync checkpoint untouched.
    const committed = await withOrgScope(auth, async (tx) => {
      const n = step.complete
        ? await tx.$executeRaw`
            UPDATE integrations
               SET sync_cursor = ${cursorAfter}, backfill_cursor = NULL, last_synced_at = now(),
                   last_error = NULL, sync_lease_expires_at = NULL, updated_at = now()
             WHERE id = ${integration.id}::uuid AND sync_lease_expires_at = ${ctx.lease}`
        : await tx.$executeRaw`
            UPDATE integrations
               SET last_error = NULL, sync_lease_expires_at = NULL, updated_at = now()
             WHERE id = ${integration.id}::uuid AND sync_lease_expires_at = ${ctx.lease}`;
      if (n === 0) return false;
      await recordAudit(tx, auth, {
        event: step.complete ? "gmail.sync_completed" : "gmail.sync_partial",
        entityType: "integration",
        entityId: integration.id,
        metadata: { trigger: opts.trigger, syncType, resumed, ...counts() },
      }, { actor });
      return true;
    });
    if (!committed) throw new LeaseLostError();

    const result: GmailSyncResult = {
      integrationId: integration.id,
      syncType,
      outcome,
      resumed,
      trigger: opts.trigger,
      ...counts(),
      cursorBefore,
      cursorAfter,
      durationMs: clock.now() - started,
    };
    log.info(step.complete ? "gmail.sync_completed" : "gmail.sync_partial", { ...logBase, ...result });
    return result;
  } catch (err) {
    const failure = safeFailure(err);
    await withOrgScope(auth, async (tx) => {
      // Release our lease and record a safe error. Cursors are untouched, so
      // a backfill in progress resumes from where it stopped.
      await tx.$executeRaw`
        UPDATE integrations
           SET sync_lease_expires_at = NULL, last_error = ${failure.message}, updated_at = now()
         WHERE id = ${integration.id}::uuid AND sync_lease_expires_at = ${ctx.lease}`;
      await recordAudit(tx, auth, {
        event: "gmail.sync_failed",
        entityType: "integration",
        entityId: integration.id,
        metadata: {
          trigger: opts.trigger,
          syncType,
          errorCode: failure.code,
          ...(err instanceof MailboxError ? err.diagnostics : {}),
          ...counts(),
        },
      }, { actor });
    }).catch(() => undefined);
    log.error("gmail.sync_failed", {
      ...logBase,
      syncType,
      resumed,
      cursorBefore,
      errorCode: failure.code,
      errorName: err instanceof Error ? err.name : typeof err,
      ...(err instanceof MailboxError ? err.diagnostics : {}),
      ...counts(),
      durationMs: clock.now() - started,
    });
    throw failure.appError ?? err;
  }
}
