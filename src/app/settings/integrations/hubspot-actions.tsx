"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** ADMIN: HubSpot Sync now / Disconnect (read-only connection). */
export function HubSpotActions() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function call(method: "POST" | "DELETE", path: string, label: "sync" | "disconnect") {
    if (label === "disconnect" && !window.confirm("Disconnect HubSpot? Synced deals and health data are removed.")) return;
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
      <button className="rounded border px-3 py-1" disabled={busy !== null} onClick={() => call("DELETE", "/api/integrations/hubspot", "disconnect")}>
        Disconnect
      </button>
      {message && <span className="text-neutral-500">{message}</span>}
    </div>
  );
}
