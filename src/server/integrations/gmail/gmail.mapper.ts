import { decodeHtmlEntities, normalizeBody } from "@/domain/email/body";
import { decodeBytes, decodeEncodedWords, parseAddressList } from "@/domain/email/participants";
import type { EmailMetadata, NormalizedEmailMessage } from "@/domain/email/types";

import type { GmailHeader, GmailMessage, GmailMessagePart } from "./gmail.types";

/**
 * Gmail message → provider-neutral NormalizedEmailMessage.
 * Never throws for optional/malformed content: bad participants are dropped,
 * missing bodies become null, unusual MIME trees are walked defensively.
 * Returns null for messages Tracklibute does not ingest.
 */
export const EXCLUDED_LABELS = new Set(["DRAFT", "SPAM", "TRASH", "CHAT"]);
const SYSTEM_LABEL = /^(INBOX|SENT|IMPORTANT|STARRED|UNREAD|CATEGORY_[A-Z]+)$/;
const MAX_PARTS_VISITED = 200;
const MAX_DEPTH = 20;
const MAX_SNIPPET = 500;
const MAX_SUBJECT = 1_000;
const MAX_REFERENCES = 20;

export function isExcluded(labelIds: readonly string[] | undefined): boolean {
  return (labelIds ?? []).some((l) => EXCLUDED_LABELS.has(l));
}

function headerMap(headers: GmailHeader[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const h of headers ?? []) {
    if (typeof h?.name !== "string" || typeof h?.value !== "string") continue;
    const key = h.name.toLowerCase();
    if (!map.has(key)) map.set(key, h.value);
  }
  return map;
}

function charsetOf(part: GmailMessagePart): string | null {
  const ct = headerMap(part.headers).get("content-type") ?? "";
  const m = ct.match(/charset\s*=\s*"?([^";\s]+)"?/i);
  return m?.[1] ?? null;
}

function decodePartData(part: GmailMessagePart): string | null {
  const data = part.body?.data;
  if (typeof data !== "string" || !data) return null;
  try {
    return decodeBytes(Buffer.from(data, "base64url"), charsetOf(part));
  } catch {
    return null;
  }
}

/** Depth-first search for the first inline text/plain and text/html parts. */
export function extractBodies(payload: GmailMessagePart | undefined): { plain: string | null; html: string | null } {
  let plain: string | null = null;
  let html: string | null = null;
  let visited = 0;
  const walk = (part: GmailMessagePart | undefined, depth: number) => {
    if (!part || depth > MAX_DEPTH || visited++ > MAX_PARTS_VISITED || (plain && html)) return;
    const mime = (part.mimeType ?? "").toLowerCase();
    const isAttachment = Boolean(part.filename) || Boolean(part.body?.attachmentId);
    if (!isAttachment) {
      if (mime === "text/plain" && plain === null) plain = decodePartData(part);
      else if (mime === "text/html" && html === null) html = decodePartData(part);
    }
    if (Array.isArray(part.parts)) for (const child of part.parts) walk(child, depth + 1);
  };
  walk(payload, 0);
  return { plain, html };
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function clean(value: string | undefined, max: number): string | null {
  if (!value) return null;
  const v = decodeEncodedWords(value).replace(/\s+/g, " ").trim();
  return v ? v.slice(0, max) : null;
}

function metadataFrom(h: Map<string, string>): EmailMetadata {
  const refs = (h.get("references") ?? "").match(/<[^<>\s]+>/g) ?? [];
  return {
    messageIdHeader: clean(h.get("message-id"), 500),
    inReplyTo: clean(h.get("in-reply-to"), 500),
    references: refs.slice(-MAX_REFERENCES),
    replyTo: parseAddressList(h.get("reply-to")).slice(0, 10),
    listId: clean(h.get("list-id"), 300),
    hasListUnsubscribe: h.has("list-unsubscribe"),
    precedence: clean(h.get("precedence"), 50),
    autoSubmitted: clean(h.get("auto-submitted"), 50),
  };
}

export function mapGmailMessage(msg: GmailMessage): NormalizedEmailMessage | null {
  if (!msg || typeof msg.id !== "string" || typeof msg.threadId !== "string") return null;
  if (isExcluded(msg.labelIds)) return null;

  const h = headerMap(msg.payload?.headers);
  const sentAt = parseDate(h.get("date"));
  const internal = Number(msg.internalDate);
  const receivedAt = Number.isFinite(internal) && internal > 0 ? new Date(internal) : sentAt;
  if (!receivedAt) return null;

  const body = normalizeBody(extractBodies(msg.payload));
  return {
    externalMessageId: msg.id,
    externalThreadId: msg.threadId,
    from: parseAddressList(h.get("from"))[0] ?? null,
    to: parseAddressList(h.get("to")),
    cc: parseAddressList(h.get("cc")),
    bcc: parseAddressList(h.get("bcc")),
    subject: clean(h.get("subject"), MAX_SUBJECT),
    snippet: msg.snippet ? clean(decodeHtmlEntities(msg.snippet), MAX_SNIPPET) : null,
    bodyText: body.text,
    bodyTruncated: body.truncated,
    sentAt,
    receivedAt,
    labels: (msg.labelIds ?? []).filter((l) => SYSTEM_LABEL.test(l)),
    metadata: metadataFrom(h),
  };
}
