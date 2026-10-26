import Link from "next/link";

import { hasRole } from "@/domain/auth/auth-context";
import { requirePageAuth } from "@/server/auth/page-session";
import { getGmailStatus } from "@/server/integrations/gmail/gmail-connection.service";
import { getHubSpotStatus } from "@/server/integrations/hubspot/hubspot-connection.service";
import { listResponsibilities } from "@/server/responsibilities/responsibilities.service";

import { GmailActions } from "./gmail-actions";
import { HubSpotActions } from "./hubspot-actions";

export const dynamic = "force-dynamic";

const NOTICES: Record<string, string> = {
  connected: "Gmail connected. The first sync runs in the background.",
  consent_denied: "Gmail access was not granted.",
  invalid_state: "The Gmail connection request expired. Please try again.",
  connect_failed: "We couldn't connect Gmail. Please try again.",
  api_disabled: "Gmail couldn't be connected: the Gmail API is not enabled for this app's Google Cloud project. An administrator must enable it, then connect again.",
  insufficient_scope: "Gmail read access wasn't fully granted. Please connect again and allow read-only access.",
};

const HUBSPOT_NOTICES: Record<string, string> = {
  connected: "HubSpot connected (read-only). The first sync runs in the background.",
  synced: "HubSpot synced.",
  consent_denied: "HubSpot access was not granted.",
  invalid_state: "The HubSpot connection request expired. Please try again.",
  forbidden: "Only an admin can connect HubSpot.",
  permissions: "HubSpot didn't grant the required read-only permissions (or the app requests write access). Nothing was stored.",
  app_config: "This HubSpot app can't be used: it must be an account-level app issued for Tracklibute's client ID. Nothing was stored.",
  not_configured: "HubSpot rejected or is missing Tracklibute's app credentials. An operator must check the HubSpot app configuration.",
  connect_failed: "We couldn't connect HubSpot. Please try again.",
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

const RESPONSIBILITY_NOTICES: Record<string, string> = {
  installed: "Default responsibilities are installed.",
  health_failed: "Default responsibilities are installed, but the Opportunity Health run failed — see the HubSpot card for details.",
};

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ gmail?: string; hubspot?: string; responsibilities?: string }>;
}) {
  const auth = await requirePageAuth();
  const [status, hubspot, responsibilities, { gmail, hubspot: hubspotNotice, responsibilities: respNotice }] = await Promise.all([
    getGmailStatus(auth),
    getHubSpotStatus(auth),
    listResponsibilities(auth),
    searchParams,
  ]);
  const oh = hubspot.opportunityHealth;
  const leadHealth = responsibilities.find((r) => r.templateKey === "lead_health") ?? null;
  const canConnect = auth.role !== "VIEWER";
  const isAdmin = hasRole(auth, "ADMIN");

  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold">Integrations</h1>
      {gmail && NOTICES[gmail] && <p className="text-sm text-neutral-600">{NOTICES[gmail]}</p>}
      {hubspotNotice && HUBSPOT_NOTICES[hubspotNotice] && <p className="text-sm text-neutral-600">{HUBSPOT_NOTICES[hubspotNotice]}</p>}
      {respNotice && RESPONSIBILITY_NOTICES[respNotice] && <p className="text-sm text-neutral-600">{RESPONSIBILITY_NOTICES[respNotice]}</p>}

      <div className="space-y-3 rounded border p-4">
        <h2 className="font-medium">HubSpot</h2>
        {hubspot.status === "CONNECTED" ? (
          <>
            <p className="text-sm text-green-700">Connected · read-only</p>
            <dl className="grid grid-cols-[9rem_1fr] gap-y-1 text-sm">
              <dt className="text-neutral-500">Portal</dt>
              <dd>{hubspot.hubId}</dd>
              <dt className="text-neutral-500">Last sync</dt>
              <dd>{hubspot.syncInProgress ? "in progress…" : fmt(hubspot.lastSyncedAt)}</dd>
              <dt className="text-neutral-500">Open deals</dt>
              <dd>
                {hubspot.openDeals} of {hubspot.deals}
                {hubspot.unknownStatusDeals > 0 && ` (${hubspot.unknownStatusDeals} with unknown open/closed status)`}
              </dd>
              {hubspot.pipelineMetadataStatus === "UNAVAILABLE" && (
                <>
                  <dt className="text-neutral-500">Pipelines</dt>
                  <dd className="text-amber-700">
                    HubSpot pipeline stages couldn&apos;t be read ({hubspot.pipelineMetadataError ?? "unknown reason"}). Deals still sync;
                    deals whose open/closed status can&apos;t be determined are left out of Opportunity Health.
                  </dd>
                </>
              )}
              <dt className="text-neutral-500">Owners</dt>
              <dd>
                {hubspot.owners} ({hubspot.unmappedOwners} not mapped) · <Link href="/settings/crm-owners" className="underline">mapping</Link>
              </dd>
              {hubspot.lastError && (
                <>
                  <dt className="text-neutral-500">Last error</dt>
                  <dd className="text-amber-700">{hubspot.lastError}</dd>
                </>
              )}
            </dl>
            <div className="space-y-2 border-t pt-3 text-sm">
              <p className="font-medium">Opportunity Health</p>
              {!oh.installed ? (
                <p className="text-amber-700">Not installed — deals can&apos;t be evaluated until it is.</p>
              ) : oh.responsibilityStatus !== "ACTIVE" ? (
                <p className="text-amber-700">Installed but {oh.responsibilityStatus?.toLowerCase()}.</p>
              ) : (
                <p className="text-neutral-600">
                  {oh.lastRun
                    ? `Last run ${oh.lastRun.status.toLowerCase()}${oh.lastRun.finishedAt ? ` at ${fmt(oh.lastRun.finishedAt)}` : ""}${
                        oh.lastRun.dealsEvaluated !== null ? ` · ${oh.lastRun.dealsEvaluated} deals evaluated` : ""
                      }${oh.lastRun.error ? ` (${oh.lastRun.error})` : ""}`
                    : "Not run yet."}
                </p>
              )}
              {oh.lastFailure && (
                <p className="text-amber-700">
                  Last automatic run failed ({fmt(oh.lastFailure.at)}): {oh.lastFailure.message}
                </p>
              )}
              {isAdmin && (
                <div className="flex flex-wrap gap-2">
                  {!oh.installed && (
                    <form method="post" action="/api/responsibilities/system">
                      <input type="hidden" name="runOpportunityHealth" value="true" />
                      <button type="submit" className="rounded border px-3 py-1">
                        Install default responsibilities &amp; run Opportunity Health
                      </button>
                    </form>
                  )}
                  {oh.installed && oh.responsibilityId && oh.responsibilityStatus === "ACTIVE" && (
                    <form method="post" action={`/api/responsibilities/${oh.responsibilityId}/run`}>
                      <button type="submit" className="rounded border px-3 py-1">
                        Run Opportunity Health now
                      </button>
                    </form>
                  )}
                </div>
              )}
            </div>
            {leadHealth && (
              <div className="space-y-2 border-t pt-3 text-sm">
                <p className="font-medium">Lead Health</p>
                {leadHealth.status !== "ACTIVE" ? (
                  <p className="text-amber-700">Installed but {leadHealth.status.toLowerCase()}.</p>
                ) : (
                  <p className="text-neutral-600">
                    Evaluates qualified HubSpot contacts, using matched Gmail activity and CRM activity timestamps. Active deals and customer contacts are excluded.
                  </p>
                )}
                {isAdmin && leadHealth.status === "ACTIVE" && (
                  <form method="post" action={`/api/responsibilities/${leadHealth.id}/run`}>
                    <button type="submit" className="rounded border px-3 py-1">Run Lead Health now</button>
                  </form>
                )}
              </div>
            )}
            {isAdmin && <HubSpotActions />}
          </>
        ) : hubspot.status === "REAUTH_REQUIRED" ? (
          <>
            <p className="text-sm text-amber-700">Reconnection required</p>
            {isAdmin && (
              <a href="/api/integrations/hubspot/connect" className="inline-block rounded border px-3 py-1 text-sm">
                Reconnect HubSpot
              </a>
            )}
          </>
        ) : (
          <>
            <p className="text-sm text-neutral-500">Not connected</p>
            {isAdmin ? (
              <a href="/api/integrations/hubspot/connect" className="inline-block rounded border px-3 py-1 text-sm">
                Connect HubSpot
              </a>
            ) : (
              <p className="text-xs text-neutral-500">An admin connects HubSpot for the whole organization.</p>
            )}
            <p className="text-xs text-neutral-500">Read-only: Tracklibute never writes to your CRM.</p>
          </>
        )}
      </div>

      <div className="space-y-3 rounded border p-4">
        <h2 className="font-medium">Gmail</h2>
        {status.status === "CONNECTED" ? (
          <>
            <p className="text-sm text-green-700">Connected</p>
            <dl className="grid grid-cols-[9rem_1fr] gap-y-1 text-sm">
              <dt className="text-neutral-500">Account</dt>
              <dd>{status.accountEmail}</dd>
              <dt className="text-neutral-500">Last sync</dt>
              <dd>
                {status.syncInProgress
                  ? "in progress…"
                  : status.initialSyncComplete
                    ? fmt(status.lastSyncedAt)
                    : status.backfillInProgress
                      ? "initial sync in progress (continues automatically)"
                      : "not started"}
              </dd>
              <dt className="text-neutral-500">Messages synced</dt>
              <dd>{status.messagesSynced}</dd>
              {status.lastError && (
                <>
                  <dt className="text-neutral-500">Last error</dt>
                  <dd className="text-amber-700">{status.lastError}</dd>
                </>
              )}
            </dl>
            <GmailActions connected />
          </>
        ) : status.status === "REAUTH_REQUIRED" ? (
          <>
            <p className="text-sm text-amber-700">Reconnection required</p>
            <a href="/api/integrations/gmail/connect" className="inline-block rounded border px-3 py-1 text-sm">
              Reconnect Gmail
            </a>
          </>
        ) : (
          <>
            <p className="text-sm text-neutral-500">Not connected</p>
            {canConnect ? (
              <a href="/api/integrations/gmail/connect" className="inline-block rounded border px-3 py-1 text-sm">
                Connect Gmail
              </a>
            ) : (
              <p className="text-xs text-neutral-500">Viewers cannot connect a mailbox.</p>
            )}
            <p className="text-xs text-neutral-500">Read-only access. Only you can see your synced email.</p>
          </>
        )}
      </div>
    </section>
  );
}
