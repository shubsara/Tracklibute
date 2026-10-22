import type { EmailDirection, EmailMetadata, EmailParticipant } from "./types";

/**
 * Content-free EmailActivity derivation.
 *
 * Owner-private mail stays owner-private. What the organization may see is
 * only: which teammate's mailbox exchanged mail with which EXTERNAL address,
 * in which direction, and when — never subject, snippet, body, labels or names.
 *
 * Eligible messages:
 *   · direction INBOUND or OUTBOUND (UNKNOWN produces nothing)
 *   · not bulk / automated mail (List-Id, List-Unsubscribe, Precedence
 *     bulk|list|junk, Auto-Submitted other than "no")
 *   · at least one external counterpart
 * Counterparts:
 *   · OUTBOUND → To + Cc recipients (Bcc excluded)
 *   · INBOUND  → the sender
 * Internal addresses never become counterparts: the mailbox itself, members of
 * the organization, the configured internal domains, and the mailbox's own
 * domain unless it is a public email provider.
 */

/** Public mailbox providers: never treated as a company/internal domain. */
export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.de",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "qq.com",
  "163.com",
  "fastmail.com",
  "hey.com",
]);

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Lowercased host part of an address, or null. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 1) return null;
  const d = email.slice(at + 1).trim().toLowerCase();
  return DOMAIN.test(d) ? d : null;
}

/** Normalize a website / domain value ("https://www.Acme.io/x" → "acme.io"). */
export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/^www\./, "");
  return DOMAIN.test(d) ? d : null;
}

export function isPublicEmailDomain(domain: string): boolean {
  return PUBLIC_EMAIL_DOMAINS.has(domain);
}

/** Exact domain or a subdomain of it. */
export function domainMatches(candidate: string, domain: string): boolean {
  return candidate === domain || candidate.endsWith(`.${domain}`);
}

export interface ActivityRules {
  /** Connected mailbox address (lowercase). */
  readonly mailboxAddress: string;
  /** Organization-configured internal domains (lowercase). */
  readonly internalDomains: readonly string[];
  /** Email addresses of organization members (lowercase). */
  readonly memberEmails: ReadonlySet<string>;
}

export interface ActivitySource {
  readonly direction: EmailDirection;
  readonly from: EmailParticipant | null;
  readonly to: readonly EmailParticipant[];
  readonly cc: readonly EmailParticipant[];
  readonly metadata: Pick<EmailMetadata, "listId" | "hasListUnsubscribe" | "precedence" | "autoSubmitted"> | null;
}

export interface DerivedActivity {
  readonly direction: "INBOUND" | "OUTBOUND";
  readonly counterpartEmail: string;
  readonly counterpartDomain: string;
}

export function isAutomatedMessage(meta: ActivitySource["metadata"]): boolean {
  if (!meta) return false;
  if (meta.listId || meta.hasListUnsubscribe) return true;
  const precedence = meta.precedence?.trim().toLowerCase();
  if (precedence && ["bulk", "list", "junk"].includes(precedence)) return true;
  const auto = meta.autoSubmitted?.trim().toLowerCase();
  return Boolean(auto && auto !== "no");
}

export function isInternalAddress(email: string, rules: ActivityRules): boolean {
  const address = email.toLowerCase();
  if (address === rules.mailboxAddress.toLowerCase() || rules.memberEmails.has(address)) return true;
  const domain = emailDomain(address);
  if (!domain) return true; // unparseable → never exposed
  const mailboxDomain = emailDomain(rules.mailboxAddress);
  if (mailboxDomain && !isPublicEmailDomain(mailboxDomain) && domainMatches(domain, mailboxDomain)) return true;
  return rules.internalDomains.some((d) => domainMatches(domain, d));
}

/** Zero or more content-free activity rows for one message. */
export function deriveEmailActivities(msg: ActivitySource, rules: ActivityRules): DerivedActivity[] {
  if (msg.direction !== "INBOUND" && msg.direction !== "OUTBOUND") return [];
  if (isAutomatedMessage(msg.metadata)) return [];
  const candidates = msg.direction === "INBOUND" ? (msg.from ? [msg.from] : []) : [...msg.to, ...msg.cc];
  const out: DerivedActivity[] = [];
  const seen = new Set<string>();
  for (const p of candidates) {
    const email = p.email.toLowerCase();
    if (seen.has(email) || isInternalAddress(email, rules)) continue;
    const domain = emailDomain(email);
    if (!domain) continue;
    seen.add(email);
    out.push({ direction: msg.direction, counterpartEmail: email, counterpartDomain: domain });
  }
  return out;
}
