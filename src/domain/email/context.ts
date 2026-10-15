import type { EmailDirection, EmailParticipant } from "./types";

/**
 * NormalizedEmailContext — what future responsibility engines (Follow-up,
 * Opportunity Health, Lead Health) consume. Provider-neutral by construction:
 * there is no way to reach a Gmail object from here.
 *
 * All text fields are UNTRUSTED external content.
 */
export interface ContextMessage {
  readonly id: string;
  readonly from: EmailParticipant | null;
  readonly to: readonly EmailParticipant[];
  readonly cc: readonly EmailParticipant[];
  readonly direction: EmailDirection;
  readonly sentAt: Date | null;
  readonly receivedAt: Date;
  readonly subject: string | null;
  readonly bodyText: string | null;
}

export interface NormalizedEmailContext {
  readonly thread: { readonly id: string; readonly subject: string | null };
  readonly messages: readonly ContextMessage[];
  /** Everyone except the mailbox owner. */
  readonly participants: readonly EmailParticipant[];
  readonly firstActivityAt: Date | null;
  readonly lastActivityAt: Date | null;
  readonly messageCount: number;
  /** Direction of the most recent message (who spoke last). */
  readonly lastDirection: EmailDirection | null;
  readonly inboundCount: number;
  readonly outboundCount: number;
}

export function buildEmailContext(
  thread: { id: string; subject: string | null },
  messages: readonly ContextMessage[],
  mailboxAddress: string | null,
): NormalizedEmailContext {
  const ordered = [...messages].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  const self = mailboxAddress?.toLowerCase() ?? null;
  const participants = new Map<string, EmailParticipant>();
  for (const m of ordered) {
    for (const p of [m.from, ...m.to, ...m.cc]) {
      if (!p || p.email === self) continue;
      const existing = participants.get(p.email);
      if (!existing || (!existing.name && p.name)) participants.set(p.email, p);
    }
  }
  const last = ordered.at(-1) ?? null;
  return {
    thread,
    messages: ordered,
    participants: [...participants.values()],
    firstActivityAt: ordered[0]?.receivedAt ?? null,
    lastActivityAt: last?.receivedAt ?? null,
    messageCount: ordered.length,
    lastDirection: last?.direction ?? null,
    inboundCount: ordered.filter((m) => m.direction === "INBOUND").length,
    outboundCount: ordered.filter((m) => m.direction === "OUTBOUND").length,
  };
}
