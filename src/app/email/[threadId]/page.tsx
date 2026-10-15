import Link from "next/link";
import { notFound } from "next/navigation";

import { NotFoundError } from "@/lib/errors";
import { requirePageAuth } from "@/server/auth/page-session";
import { getThread, type ThreadDetailDTO } from "@/server/email/email.service";

export const dynamic = "force-dynamic";

const who = (p: { email: string; name: string | null } | null) => (p ? (p.name ? `${p.name} <${p.email}>` : p.email) : "(unknown)");

export default async function ThreadPage({ params }: { params: Promise<{ threadId: string }> }) {
  const auth = await requirePageAuth();
  const { threadId } = await params;
  let thread: ThreadDetailDTO;
  try {
    thread = await getThread(auth, threadId);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  return (
    <section className="space-y-4">
      <Link href="/email" className="text-sm underline">
        ← Threads
      </Link>
      <h1 className="text-xl font-semibold">{thread.subject ?? "(no subject)"}</h1>
      {thread.messages.map((m) => (
        <article key={m.id} className="space-y-2 rounded border p-3 text-sm">
          <div className="grid grid-cols-[4rem_1fr] gap-y-0.5 text-neutral-600">
            <span>From</span>
            <span>{who(m.from)}</span>
            <span>To</span>
            <span>{m.to.map(who).join(", ") || "—"}</span>
            {m.cc.length > 0 && (
              <>
                <span>Cc</span>
                <span>{m.cc.map(who).join(", ")}</span>
              </>
            )}
            <span>Date</span>
            <span>
              {new Date(m.sentAt ?? m.receivedAt).toLocaleString()} · {m.direction.toLowerCase()}
            </span>
          </div>
          {/* Rendered as plain text (React escapes it): untrusted content is never interpreted. */}
          <pre className="whitespace-pre-wrap font-sans">{m.bodyText ?? "(no text body)"}</pre>
          {m.bodyTruncated && <p className="text-xs text-neutral-500">Body truncated.</p>}
        </article>
      ))}
    </section>
  );
}
