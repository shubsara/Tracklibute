import "server-only";

import { log } from "@/lib/log";
import { contextFromIdentity } from "@/server/auth/resolve";
import { getAppDb } from "@/server/db/client";

import { runOpportunityHealth } from "./opportunity-health.service";

export interface OpportunityHealthCronSummary {
  candidates: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: Array<{ organizationId: string; outcome: "succeeded" | "failed" | "skipped"; dealsEvaluated?: number; errorCode?: string }>;
}

const CRON_TOTAL_BUDGET_MS = 250_000;

/**
 * Re-evaluate Opportunity Health for due organizations (sequential, bounded).
 * Picks up new email activity between HubSpot syncs. Database-only: no
 * provider calls. Runs under an ADMIN/OWNER identity, audited as SYSTEM.
 */
export async function runOpportunityHealthCron(opts: { limit?: number; totalBudgetMs?: number; now?: Date } = {}): Promise<OpportunityHealthCronSummary> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const deadline = Date.now() + (opts.totalBudgetMs ?? CRON_TOTAL_BUDGET_MS);
  const candidates = await getAppDb().$queryRaw<{ organization_id: string; responsibility_id: string; actor_user_id: string | null }[]>`
    SELECT organization_id::text, responsibility_id::text, actor_user_id::text FROM opportunity_health_candidates(${limit}::int)`;
  const summary: OpportunityHealthCronSummary = { candidates: candidates.length, succeeded: 0, failed: 0, skipped: 0, results: [] };
  for (const c of candidates) {
    if (Date.now() >= deadline) {
      summary.skipped++;
      summary.results.push({ organizationId: c.organization_id, outcome: "skipped", errorCode: "cron_budget_exhausted" });
      continue;
    }
    const auth = c.actor_user_id ? await contextFromIdentity({ userId: c.actor_user_id, organizationId: c.organization_id }) : null;
    if (!auth) {
      summary.skipped++;
      summary.results.push({ organizationId: c.organization_id, outcome: "skipped", errorCode: "no_admin" });
      continue;
    }
    try {
      const r = await runOpportunityHealth(auth, { trigger: "cron", now: opts.now });
      summary.succeeded++;
      summary.results.push({ organizationId: c.organization_id, outcome: "succeeded", dealsEvaluated: r.dealsEvaluated });
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "error";
      const outcome = code === "conflict" ? "skipped" : "failed";
      summary[outcome]++;
      summary.results.push({ organizationId: c.organization_id, outcome, errorCode: code });
    }
  }
  log.info("opportunity_health.cron_run", { candidates: summary.candidates, succeeded: summary.succeeded, failed: summary.failed, skipped: summary.skipped });
  return summary;
}
