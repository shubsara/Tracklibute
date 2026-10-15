"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Sync now / Disconnect — same-origin fetch so DELETE can be used. */
export function GmailActions({ connected }: { connected: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function call(method: "POST" | "DELETE", path: string, label: string) {
    setBusy(label);
    setMessage(null);
    try {
      const res = await fetch(path, { method });
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
        data?: { messagesUpserted?: number; outcome?: "completed" | "partial" };
      };
      const synced = `Synced ${body.data?.messagesUpserted ?? 0} new messages.`;
      setMessage(
        !res.ok
          ? (body.error?.message ?? "Something went wrong.")
          : label !== "sync"
            ? "Disconnected."
            : body.data?.outcome === "partial"
              ? `${synced} Initial sync is still in progress and will continue automatically.`
              : synced,
      );
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      {connected && (
        <button className="rounded border px-3 py-1" disabled={busy !== null} onClick={() => call("POST", "/api/integrations/gmail/sync", "sync")}>
          {busy === "sync" ? "Syncing…" : "Sync now"}
        </button>
      )}
      <button className="rounded border px-3 py-1" disabled={busy !== null} onClick={() => call("DELETE", "/api/integrations/gmail", "disconnect")}>
        Disconnect
      </button>
      {message && <span className="text-neutral-500">{message}</span>}
    </div>
  );
}
