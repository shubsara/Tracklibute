import { after } from "next/server";

import { hasRole } from "@/domain/auth/auth-context";
import { CrmError } from "@/domain/crm/types";
import { AppError } from "@/lib/errors";
import { log } from "@/lib/log";
import { clearOAuthTransactionCookie, readOAuthTransaction } from "@/server/auth/oauth-state";
import { getAuthContext } from "@/server/auth/resolve";
import { redirect } from "@/server/http/route";
import { completeHubSpotConnect } from "@/server/integrations/hubspot/hubspot-connection.service";
import { syncHubSpot } from "@/server/integrations/hubspot/hubspot-sync.service";
import { runOpportunityHealth } from "@/server/opportunity-health/opportunity-health.service";

export const dynamic = "force-dynamic";
// The first sync runs in `after()` within this route's duration; it is
// time-boxed (HUBSPOT_SYNC_RUN_BUDGET_SECONDS) and resumes on later runs.
export const maxDuration = 300;

const SETTINGS = "/settings/integrations";

function runAfterResponse(task: () => Promise<unknown>): void {
  try {
    after(() => task().catch(() => undefined));
  } catch {
    log.info("hubspot.initial_sync_deferred", {});
  }
}

/**
 * HubSpot redirects here after consent. Requires an authenticated ADMIN
 * session; the organization comes from that session and must match the
 * signed transaction. Query-string identifiers are never trusted.
 */
export async function GET(request: Request): Promise<Response> {
  const clearTx = clearOAuthTransactionCookie("hubspot");
  const auth = await getAuthContext(request.headers);
  if (!auth) return redirect("/login?error=session_required", 303, [clearTx]);
  if (!hasRole(auth, "ADMIN")) return redirect(`${SETTINGS}?hubspot=forbidden`, 303, [clearTx]);

  const transaction = readOAuthTransaction(request.headers, "hubspot");
  const state = new URL(request.url).searchParams.get("state");
  if (!transaction || state !== transaction.state) {
    log.warn("hubspot.connect_failed", { organizationId: auth.organizationId, reason: "invalid_state" });
    return redirect(`${SETTINGS}?hubspot=invalid_state`, 303, [clearTx]);
  }
  if (new URL(request.url).searchParams.has("error")) {
    return redirect(`${SETTINGS}?hubspot=consent_denied`, 303, [clearTx]);
  }
  try {
    const result = await completeHubSpotConnect(auth, request.url, transaction);
    if (result.isFirstConnection) {
      runAfterResponse(async () => {
        const r = await syncHubSpot(auth, { trigger: "connect" });
        if (r.outcome === "completed") await runOpportunityHealth(auth, { trigger: "sync" });
      });
    }
    return redirect(`${SETTINGS}?hubspot=connected`, 303, [clearTx]);
  } catch (err) {
    const reason = err instanceof AppError ? err.code : err instanceof CrmError ? err.kind : "error";
    log.warn("hubspot.connect_failed", { organizationId: auth.organizationId, reason, errorName: err instanceof Error ? err.name : typeof err });
    const outcome = err instanceof AppError && err.code === "validation_failed" ? "permissions" : "connect_failed";
    return redirect(`${SETTINGS}?hubspot=${outcome}`, 303, [clearTx]);
  }
}
