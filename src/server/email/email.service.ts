import "server-only";

import { z } from "zod";

import type { AuthContext } from "@/domain/auth/auth-context";
import { buildEmailContext, type NormalizedEmailContext } from "@/domain/email/context";
import type { EmailDirection, EmailParticipant } from "@/domain/email/types";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { withOrgScope } from "@/server/db/org-scope";

/**
 * Read access to normalized email context. Raw mailbox data is OWNER-PRIVATE:
 * every query is scoped to (organizationId, mailboxUserId = auth.userId) in
 * application code, and PostgreSQL RLS enforces the same rule independently.
 * No caller-supplied mailbox/user/organization id is ever accepted.
 */
export const THREAD_PAGE_MAX = 50;
const PARTICIPANTS_PER_THREAD = 10;

export interface ThreadSummaryDTO {
  id: string;
  subject: string | null;
  participants: EmailParticipant[];
  messageCount: number;
  firstMessageAt: string;
  lastMessageAt: string;
}

export interface ThreadListDTO {
  threads: ThreadSummaryDTO[];
  nextCursor: string | null;
}

export interface MessageDTO {
  id: string;
  from: EmailParticipant | null;
  to: EmailParticipant[];
  cc: EmailParticipant[];
  bcc: EmailParticipant[];
  subject: string | null;
  direction: EmailDirection;
  sentAt: string | null;
  receivedAt: string;
  bodyText: string | null;
  bodyTruncated: boolean;
}

export interface ThreadDetailDTO extends ThreadSummaryDTO {
  messages: MessageDTO[];
}

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(THREAD_PAGE_MAX).default(25),
  cursor: z.string().max(200).optional(),
});

function encodeCursor(lastMessageAt: Date, id: string): string {
  return Buffer.from(`${lastMessageAt.toISOString()}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string): { lastMessageAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const at = new Date(iso ?? "");
  if (!id || Number.isNaN(at.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) throw new ValidationError("Invalid cursor");
  return { lastMessageAt: at, id };
}

function ownerScope(auth: AuthContext) {
  return { organizationId: auth.organizationId, mailboxUserId: auth.userId };
}

function participant(email: string | null, name: string | null): EmailParticipant | null {
  return email ? { email, name } : null;
}

/** Owner-scoped, keyset-paginated thread list (newest activity first). No bodies. */
export async function listThreads(auth: AuthContext, query: Record<string, string | undefined>): Promise<ThreadListDTO> {
  const parsed = listQuery.safeParse(query);
  if (!parsed.success) throw new ValidationError("Invalid pagination parameters");
  const { limit, cursor } = parsed.data;
  const after = cursor ? decodeCursor(cursor) : null;

  return withOrgScope(auth, async (tx) => {
    const threads = await tx.emailThread.findMany({
      where: {
        ...ownerScope(auth),
        ...(after
          ? {
              OR: [
                { lastMessageAt: { lt: after.lastMessageAt } },
                { lastMessageAt: after.lastMessageAt, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: { id: true, subject: true, messageCount: true, firstMessageAt: true, lastMessageAt: true },
    });
    const page = threads.slice(0, limit);

    // Participants for the whole page in two queries (no N+1, no bodies).
    const ids = page.map((t) => t.id);
    const messages = ids.length
      ? await tx.emailMessage.findMany({
          where: { ...ownerScope(auth), threadId: { in: ids } },
          select: { threadId: true, fromEmail: true, fromName: true, recipients: { select: { email: true, name: true } } },
          orderBy: { receivedAt: "asc" },
        })
      : [];
    const byThread = new Map<string, Map<string, EmailParticipant>>();
    for (const m of messages) {
      const set = byThread.get(m.threadId) ?? new Map<string, EmailParticipant>();
      byThread.set(m.threadId, set);
      for (const p of [participant(m.fromEmail, m.fromName), ...m.recipients.map((r) => participant(r.email, r.name))]) {
        if (p && !set.has(p.email) && set.size < PARTICIPANTS_PER_THREAD) set.set(p.email, p);
      }
    }

    const last = page.at(-1);
    return {
      threads: page.map((t) => ({
        id: t.id,
        subject: t.subject,
        participants: [...(byThread.get(t.id)?.values() ?? [])],
        messageCount: t.messageCount,
        firstMessageAt: t.firstMessageAt.toISOString(),
        lastMessageAt: t.lastMessageAt.toISOString(),
      })),
      nextCursor: threads.length > limit && last ? encodeCursor(last.lastMessageAt, last.id) : null,
    };
  });
}

async function loadThread(auth: AuthContext, threadId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new NotFoundError("Thread not found");
  return withOrgScope(auth, async (tx) => {
    const thread = await tx.emailThread.findFirst({
      where: { id: threadId, ...ownerScope(auth) },
      select: { id: true, subject: true, messageCount: true, firstMessageAt: true, lastMessageAt: true, integrationId: true },
    });
    if (!thread) throw new NotFoundError("Thread not found");
    const [messages, integration] = await Promise.all([
      tx.emailMessage.findMany({
        where: { threadId: thread.id, ...ownerScope(auth) },
        orderBy: { receivedAt: "asc" },
        select: {
          id: true,
          fromEmail: true,
          fromName: true,
          subject: true,
          direction: true,
          sentAt: true,
          receivedAt: true,
          bodyText: true,
          bodyTruncated: true,
          recipients: { select: { kind: true, email: true, name: true } },
        },
      }),
      tx.integration.findFirst({
        where: { id: thread.integrationId, organizationId: auth.organizationId, ownerUserId: auth.userId },
        select: { externalAccountId: true },
      }),
    ]);
    return { thread, messages, mailboxAddress: integration?.externalAccountId ?? null };
  });
}

function toMessageDTO(m: Awaited<ReturnType<typeof loadThread>>["messages"][number]): MessageDTO {
  const of = (kind: "TO" | "CC" | "BCC") =>
    m.recipients.filter((r) => r.kind === kind).map((r) => ({ email: r.email, name: r.name }));
  return {
    id: m.id,
    from: participant(m.fromEmail, m.fromName),
    to: of("TO"),
    cc: of("CC"),
    bcc: of("BCC"),
    subject: m.subject,
    direction: m.direction,
    sentAt: m.sentAt?.toISOString() ?? null,
    receivedAt: m.receivedAt.toISOString(),
    bodyText: m.bodyText,
    bodyTruncated: m.bodyTruncated,
  };
}

/** Owner-scoped thread with its normalized messages. */
export async function getThread(auth: AuthContext, threadId: string): Promise<ThreadDetailDTO> {
  const { thread, messages } = await loadThread(auth, threadId);
  const dtos = messages.map(toMessageDTO);
  const participants = new Map<string, EmailParticipant>();
  for (const m of dtos) for (const p of [m.from, ...m.to, ...m.cc]) if (p && !participants.has(p.email)) participants.set(p.email, p);
  return {
    id: thread.id,
    subject: thread.subject,
    participants: [...participants.values()].slice(0, PARTICIPANTS_PER_THREAD),
    messageCount: thread.messageCount,
    firstMessageAt: thread.firstMessageAt.toISOString(),
    lastMessageAt: thread.lastMessageAt.toISOString(),
    messages: dtos,
  };
}

/**
 * The provider-neutral context future responsibility engines consume.
 * (Later specs derive organization-level sales context from this; raw mail
 * stays owner-private.)
 */
export async function getEmailContext(auth: AuthContext, threadId: string): Promise<NormalizedEmailContext> {
  const { thread, messages, mailboxAddress } = await loadThread(auth, threadId);
  return buildEmailContext(
    { id: thread.id, subject: thread.subject },
    messages.map((m) => {
      const dto = toMessageDTO(m);
      return {
        id: dto.id,
        from: dto.from,
        to: dto.to,
        cc: dto.cc,
        direction: dto.direction,
        sentAt: m.sentAt,
        receivedAt: m.receivedAt,
        subject: dto.subject,
        bodyText: dto.bodyText,
      };
    }),
    mailboxAddress,
  );
}
