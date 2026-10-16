import Link from "next/link";

import { hasRole } from "@/domain/auth/auth-context";
import { requirePageAuth } from "@/server/auth/page-session";
import { getGmailStatus } from "@/server/integrations/gmail/gmail-connection.service";
import { getHubSpotStatus } from "@/server/integrations/hubspot/hubspot-connection.service";

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
  connect_failed: "We couldn't connect HubSpot. Please try again.",
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ gmail?: string; hubspot?: string }> }) {
  const auth = await requirePageAuth();
  const [status, hubspot, { gmail, hubspot: hubspotNotice }] = await Promise.all([getGmailStatus(auth), getHubSpotStatus(auth), searchParams]);
  const canConnect = auth.role !== "VIEWER";
  const isAdmin = hasRole(auth, "ADMIN");

  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold">Integrations</h1>
      {gmail && NOTICES[gmail] && <p className="text-sm text-neutral-600">{NOTICES[gmail]}</p>}
      {hubspotNotice && HUBSPOT_NOTICES[hubspotNotice] && <p className="text-sm text-neutral-600">{HUBSPOT_NOTICES[hubspotNotice]}</p>}

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
              </dd>
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
