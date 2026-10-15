import type { EmailDirection, EmailParticipant } from "./types";

/**
 * Direction relative to the connected mailbox, decided by the sender address.
 *   sender == mailbox                       → OUTBOUND
 *   no sender                               → UNKNOWN
 *   sender != mailbox but marked SENT       → UNKNOWN  (send-as alias / conflicting signals)
 *   otherwise                               → INBOUND
 * Labels never decide direction on their own; they only flag ambiguity.
 */
export function determineDirection(
  from: EmailParticipant | null,
  mailboxAddress: string,
  labels: readonly string[],
): EmailDirection {
  const mailbox = mailboxAddress.trim().toLowerCase();
  if (!from || !mailbox) return "UNKNOWN";
  if (from.email === mailbox) return "OUTBOUND";
  if (labels.includes("SENT")) return "UNKNOWN";
  return "INBOUND";
}
