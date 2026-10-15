import Link from "next/link";

import { requirePageAuth } from "@/server/auth/page-session";
import { listThreads } from "@/server/email/email.service";

export const dynamic = "force-dynamic";

/** Development-facing proof of Gmail → adapter → normalized model → DB → API → UI. */
export default async function EmailPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const auth = await requirePageAuth();
  const { cursor } = await searchParams;
  const { threads, nextCursor } = await listThreads(auth, { cursor, limit: "25" });
  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Email context</h1>
      <p className="text-xs text-neutral-500">Your mailbox only. Email content is untrusted external data.</p>
      {threads.length === 0 ? (
        <p className="text-sm">No synced threads yet.</p>
      ) : (
        <ul className="divide-y text-sm">
          {threads.map((t) => (
            <li key={t.id} className="py-2">
              <Link href={`/email/${t.id}`} className="font-medium underline">
                {t.subject ?? "(no subject)"}
              </Link>
              <div className="text-neutral-500">
                {t.participants.map((p) => p.name ?? p.email).join(", ")} · {t.messageCount} message
                {t.messageCount === 1 ? "" : "s"} · last activity {new Date(t.lastMessageAt).toLocaleString()}
              </div>
            </li>
          ))}
        </ul>
      )}
      {nextCursor && (
        <Link className="text-sm underline" href={`/email?cursor=${encodeURIComponent(nextCursor)}`}>
          Older threads →
        </Link>
      )}
    </section>
  );
}
