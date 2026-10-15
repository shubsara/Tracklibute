import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { getEnv } from "@/lib/env";
import { ServiceUnavailableError, UnauthenticatedError } from "@/lib/errors";
import { log } from "@/lib/log";
import { contextFromIdentity } from "@/server/auth/resolve";
import { getAppDb } from "@/server/db/client";

import { syncGmailMailbox } from "./gmail-sync.service";

/** Constant-time comparison of the presented cron secret (lengths hidden via HMAC). */
export function verifyCronSecret(headers: Headers): void {
  const secret = getEnv().GMAIL_SYNC_CRON_SECRET;
  if (!secret) throw new ServiceUnavailableError("Gmail cron sync is not configured");
  const presented = (headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = createHmac("sha256", "cron").update(presented).digest();
  const b = createHmac("sha256", "cron").update(secret).digest();
  if (!presented || !timingSafeEqual(a, b)) throw new UnauthenticatedError("Invalid cron credentials");
}

export interface CronRunSummary {
  candidates: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: Array<{ integrationId: string; outcome: "succeeded" | "failed" | "skipped"; messagesUpserted?: number; errorCode?: string }>;
}

/**
 * Process due mailboxes sequentially (bounded). Each sync runs under the
 * mailbox owner's re-verified membership, inside RLS, audited as SYSTEM.
 * No queue, no workers: the lease prevents overlap with manual syncs.
 */
export async function runGmailCronSync(opts: { limit?: number } = {}): Promise<CronRunSummary> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const candidates = await getAppDb().$queryRaw<{ integration_id: string; organization_id: string; owner_user_id: string }[]>`
    SELECT integration_id::text, organization_id::text, owner_user_id::text FROM gmail_sync_candidates(${limit}::int)`;

  const summary: CronRunSummary = { candidates: candidates.length, succeeded: 0, failed: 0, skipped: 0, results: [] };
  for (const c of candidates) {
    const auth = await contextFromIdentity({ userId: c.owner_user_id, organizationId: c.organization_id });
    if (!auth) {
      summary.skipped++;
      summary.results.push({ integrationId: c.integration_id, outcome: "skipped", errorCode: "no_membership" });
      continue;
    }
    try {
      const r = await syncGmailMailbox(auth, { trigger: "cron" });
      summary.succeeded++;
      summary.results.push({ integrationId: c.integration_id, outcome: "succeeded", messagesUpserted: r.messagesUpserted });
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "error";
      const outcome = code === "conflict" ? "skipped" : "failed";
      summary[outcome === "skipped" ? "skipped" : "failed"]++;
      summary.results.push({ integrationId: c.integration_id, outcome, errorCode: code });
    }
  }
  log.info("gmail.cron_run", { candidates: summary.candidates, succeeded: summary.succeeded, failed: summary.failed, skipped: summary.skipped });
  return summary;
}
