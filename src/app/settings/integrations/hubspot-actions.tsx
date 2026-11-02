"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** ADMIN: HubSpot incremental sync, full reconciliation and disconnect (read-only connection). */
export function HubSpotActions() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function call(method: "POST" | "DELETE", path: string, label: "sync" | "full-sync" | "disconnect") {
    if (label === "disconnect" && !window.confirm("Disconnect HubSpot? Synced deals and health data are removed.")) return;
    if (label === "full-sync" && !window.confirm("Run a full HubSpot reconciliation? This reads all deals and contacts and archives records no longer present in HubSpot. Tracklibute will not write to HubSpot.")) return;
    setBusy(label);
    setMessage(null);
    try {
      const res = await fetch(path, { method });
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
        data?: { dealsUpserted?: number; outcome?: "completed" | "partial" };
      };
      setMessage(
        !res.ok
          ? (body.error?.message ?? "Something went wrong.")
          : label === "disconnect"
            ? "Disconnected."
            : label === "full-sync"
              ? body.data?.outcome === "partial"
                ? `Full reconciliation is partial: ${body.data.dealsUpserted ?? 0} deals and ${body.data.contactsUpserted ?? 0} contacts processed so far.`
                : `Full reconciliation completed: ${body.data?.dealsUpserted ?? 0} deals and ${body.data?.contactsUpserted ?? 0} contacts read.`
              : body.data?.outcome === "partial"
                ? `Synced ${body.data.dealsUpserted ?? 0} deals so far; sync continues automatically.`
                : `Synced ${body.data?.dealsUpserted ?? 0} deals.`,
      );
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <button className="rounded border px-3 py-1" disabled={busy !== null} onClick={() => call("POST", "/api/integrations/hubspot/sync", "sync")}>
        {busy === "sync" ? "Syncing…" : "Sync now"}
      </button>
      <button className="rounded border px-3 py-1" disabled={busy !== null} onClick={() => call("POST", "/api/integrations/hubspot/sync?full=true", "full-sync")}>
        {busy === "full-sync" ? "Reconciling…" : "Full sync now"}
      </button>
      <button className="rounded border px-3 py-1" disabled={busy !== null} onClick={() => call("DELETE", "/api/integrations/hubspot", "disconnect")}>
        Disconnect
      </button>
      {message && <span className="text-neutral-500">{message}</span>}
    </div>
  );
}
