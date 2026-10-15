/**
 * Provider-neutral email model. Nothing here knows about Gmail.
 *
 * All email content (subject, names, bodies, snippets) is UNTRUSTED external
 * input. It is data to display and, later, to reason over — never
 * instructions. It must not influence authorization, actions, responsibility
 * or organization configuration.
 */
export type EmailDirection = "INBOUND" | "OUTBOUND" | "UNKNOWN";
export type EmailRecipientKind = "TO" | "CC" | "BCC";

export interface EmailParticipant {
  /** Lowercased, trimmed address — the comparison key. */
  readonly email: string;
  /** Display name as written by the sender, if any. */
  readonly name: string | null;
}

/** Allow-listed header metadata useful for threading and bulk-mail detection. */
export interface EmailMetadata {
  readonly messageIdHeader: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly replyTo: readonly EmailParticipant[];
  readonly listId: string | null;
  readonly hasListUnsubscribe: boolean;
  readonly precedence: string | null;
  readonly autoSubmitted: string | null;
}

/** One message as produced by any mailbox source, before persistence. */
export interface NormalizedEmailMessage {
  readonly externalMessageId: string;
  readonly externalThreadId: string;
  readonly from: EmailParticipant | null;
  readonly to: readonly EmailParticipant[];
  readonly cc: readonly EmailParticipant[];
  readonly bcc: readonly EmailParticipant[];
  readonly subject: string | null;
  readonly snippet: string | null;
  readonly bodyText: string | null;
  readonly bodyTruncated: boolean;
  /** From the Date header; null if missing or unparseable. */
  readonly sentAt: Date | null;
  /** When the mailbox received/recorded the message (always present). */
  readonly receivedAt: Date;
  /** Provider-neutral system labels (INBOX, SENT, IMPORTANT, ...). */
  readonly labels: readonly string[];
  readonly metadata: EmailMetadata;
}

/** A page of message ids. */
export interface MessageIdPage {
  readonly ids: readonly string[];
  readonly nextPageToken: string | null;
}

/** A page of mailbox changes since a cursor. */
export interface MailboxChangePage {
  /** Messages added or relabelled — (re)fetch them. */
  readonly changed: readonly string[];
  /** Messages removed from the mailbox. */
  readonly deleted: readonly string[];
  readonly nextPageToken: string | null;
  /** The newest cursor the provider reported for this change set. */
  readonly cursor: string;
}

/**
 * Port implemented by provider adapters (Gmail today). The sync service and
 * every downstream consumer depend on THIS, never on provider response shapes.
 */
export interface MailboxSource {
  /** Connected mailbox address + a cursor representing "now". */
  getMailbox(): Promise<{ address: string; cursor: string }>;
  listMessageIdsSince(since: Date, pageToken?: string): Promise<MessageIdPage>;
  /** Null when the message no longer exists or is excluded (drafts, spam, trash, chat). */
  getMessage(externalMessageId: string): Promise<NormalizedEmailMessage | null>;
  /** Throws MailboxCursorExpiredError if the cursor is too old. */
  listChangesSince(cursor: string, pageToken?: string): Promise<MailboxChangePage>;
}

// ─── Provider-neutral failure modes ─────────────────────────────────────────

/** Non-secret diagnostics for logs: which call failed and how. Never tokens or content. */
export interface MailboxErrorDiagnostics {
  readonly endpoint?: string;
  readonly httpStatus?: number;
  readonly providerReason?: string | null;
}

export class MailboxError extends Error {
  constructor(
    message: string,
    readonly kind: "cursor_expired" | "authorization_revoked" | "rate_limited" | "unavailable" | "invalid_response",
    readonly diagnostics: MailboxErrorDiagnostics = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}
export class MailboxCursorExpiredError extends MailboxError {
  constructor(diagnostics: MailboxErrorDiagnostics = {}) {
    super("Mailbox change history is no longer available for the stored cursor", "cursor_expired", diagnostics);
  }
}
export class MailboxAuthorizationRevokedError extends MailboxError {
  constructor(diagnostics: MailboxErrorDiagnostics = {}) {
    super("Mailbox authorization was revoked or expired; the user must reconnect", "authorization_revoked", diagnostics);
  }
}
export class MailboxRateLimitedError extends MailboxError {
  constructor(diagnostics: MailboxErrorDiagnostics = {}) {
    super("Mailbox provider rate limit reached; retry later", "rate_limited", diagnostics);
  }
}
export class MailboxUnavailableError extends MailboxError {
  constructor(detail = "Mailbox provider is temporarily unavailable", diagnostics: MailboxErrorDiagnostics = {}) {
    super(detail, "unavailable", diagnostics);
  }
}
