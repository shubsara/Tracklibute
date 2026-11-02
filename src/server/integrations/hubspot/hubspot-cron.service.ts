import "server-only";

import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { contextFromIdentity } from "@/server/auth/resolve";
import { getAppDb } from "@/server/db/client";
import { runLeadHealthAfterSync } from "@/server/lead-health/lead-health.service";
import { runOpportunityHealthAfterSync } from "@/server/opportunity-health/opportunity-health.service";

import { syncHubSpot } from "./hubspot-sync.service";

export interface HubSpotCronSummary {
  candidates: number;
  succeeded: number;
  partial: number;
  failed: number;
  skipped: number;
  results: Array<{
    integrationId: string;
    outcome: "succeeded" | "partial" | "failed" | "skipped";
    dealsUpserted?: number;
    errorCode?: string;
    /** Post-sync Opportunity Health outcome (after a completed sync only). */
    health?: "succeeded" | "skipped" | "failed";
    healthErrorCode?: string;
    /** Post-sync Lead Health outcome (after a completed sync only). */
    leadHealth?: "succeeded" | "skipped" | "failed";
    leadHealthErrorCode?: string;
  }>;
}

/** Leave headroom below the route's maxDuration (300 s). */
const CRON_TOTAL_BUDGET_MS = 250_000;
const MIN_PER_PORTAL_MS = 15_000;

const errorCode = (err: unknown) => (err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "error");

/**
 * Sync due HubSpot portals sequentially (bounded), each under an ADMIN/OWNER
 * identity of its organization (re-verified membership), inside RLS, audited
 * as SYSTEM. A completed sync is followed by an Opportunity Health run.
 * No queue, no workers: the lease prevents overlap with manual syncs.
 */
export async function runHubSpotCronSync(opts: { limit?: number; totalBudgetMs?: number } = {}): Promise<HubSpotCronSummary> {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const deadline = Date.now() + (opts.totalBudgetMs ?? CRON_TOTAL_BUDGET_MS);
  const perRunCap = getEnv().HUBSPOT_SYNC_RUN_BUDGET_SECONDS * 1000;
  const candidates = await getAppDb().$queryRaw<{ integration_id: string; organization_id: string; actor_user_id: string | null }[]>`
    SELECT integration_id::text, organization_id::text, actor_user_id::text FROM hubspot_sync_candidates(${limit}::int)`;

  const summary: HubSpotCronSummary = { candidates: candidates.length, succeeded: 0, partial: 0, failed: 0, skipped: 0, results: [] };
  for (const c of candidates) {
    if (deadline - Date.now() < MIN_PER_PORTAL_MS) {
      summary.skipped++;
      summary.results.push({ integrationId: c.integration_id, outcome: "skipped", errorCode: "cron_budget_exhausted" });
      continue;
    }
    const auth = c.actor_user_id ? await contextFromIdentity({ userId: c.actor_user_id, organizationId: c.organization_id }) : null;
    if (!auth) {
      summary.skipped++;
      summary.results.push({ integrationId: c.integration_id, outcome: "skipped", errorCode: "no_admin" });
      continue;
    }
    try {
      const r = await syncHubSpot(auth, { trigger: "cron", deadlineAt: Math.min(deadline, Date.now() + perRunCap) });
      const outcome = r.outcome === "completed" ? "succeeded" : "partial";
      summary[outcome]++;
      const entry: HubSpotCronSummary["results"][number] = { integrationId: c.integration_id, outcome, dealsUpserted: r.dealsUpserted };
      if (r.outcome === "completed") {
        const health = await runOpportunityHealthAfterSync(auth, "cron");
        entry.health = health.status;
        if (health.status === "failed") entry.healthErrorCode = health.errorCode;
        const leadHealth = await runLeadHealthAfterSync(auth, "hubspot_cron");
        entry.leadHealth = leadHealth.status;
        if (leadHealth.status === "failed") entry.leadHealthErrorCode = leadHealth.errorCode;
      }
      summary.results.push(entry);
    } catch (err) {
      const code = errorCode(err);
      const outcome = code === "conflict" ? "skipped" : "failed";
      summary[outcome]++;
      summary.results.push({ integrationId: c.integration_id, outcome, errorCode: code });
    }
  }
  log.info("hubspot.cron_run", { candidates: summary.candidates, succeeded: summary.succeeded, partial: summary.partial, failed: summary.failed, skipped: summary.skipped });
  return summary;
}
