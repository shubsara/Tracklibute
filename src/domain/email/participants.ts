import type { EmailParticipant } from "./types";

/**
 * Tolerant RFC 5322-style address-list parser. Handles:
 *   a@b.co · Name <a@b.co> · "Last, First" <a@b.co> · a@b.co (comment)
 *   group syntax (undisclosed-recipients:;) · RFC 2047 encoded names
 * Invalid entries are dropped — one bad participant never fails a sync.
 */
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const MAX_PARTICIPANTS = 200;

export function normalizeEmailAddress(raw: string): string | null {
  const email = raw.trim().replace(/^mailto:/i, "").toLowerCase();
  return EMAIL.test(email) && email.length <= 320 ? email : null;
}

/** Decode RFC 2047 encoded-words (=?charset?B|Q?...?=). Unknown charsets fall back to UTF-8. */
export function decodeEncodedWords(input: string): string {
  return input
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
      try {
        const bytes =
          enc.toUpperCase() === "B"
            ? Buffer.from(text, "base64")
            : Buffer.from(
                text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))),
                "latin1",
              );
        return decodeBytes(bytes, charset);
      } catch {
        return text;
      }
    });
}

export function decodeBytes(bytes: Uint8Array, charset: string | null | undefined): string {
  try {
    return new TextDecoder((charset ?? "utf-8").trim().toLowerCase()).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Split on commas that are outside quotes, angle brackets and comments. */
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let inQuote = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === "\\" && inQuote) {
      buf += ch + (input[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"' && paren === 0) inQuote = !inQuote;
    else if (!inQuote) {
      if (ch === "(") paren++;
      else if (ch === ")" && paren > 0) paren--;
      else if (ch === "<" && paren === 0) angle++;
      else if (ch === ">" && angle > 0 && paren === 0) angle--;
      else if ((ch === "," || ch === ";") && angle === 0 && paren === 0) {
        parts.push(buf);
        buf = "";
        continue;
      }
    }
    buf += ch;
  }
  parts.push(buf);
  return parts;
}

function cleanName(raw: string): string | null {
  const name = decodeEncodedWords(raw.trim())
    .replace(/^"(.*)"$/s, "$1")
    .replace(/\\(.)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return name ? name.slice(0, 200) : null;
}

function parseOne(raw: string): EmailParticipant | null {
  let part = raw.trim();
  // Group syntax: "Group name: a@b.co, c@d.co;" is split earlier; strip a leading "label:".
  const groupIdx = part.search(/^[^"<]*:/);
  if (groupIdx === 0 && !part.includes("@")) return null;
  if (groupIdx === 0) part = part.slice(part.indexOf(":") + 1).trim();
  if (!part) return null;

  const angle = part.match(/^(.*)<([^<>]*)>\s*(\([^)]*\))?\s*$/s);
  if (angle) {
    const email = normalizeEmailAddress(angle[2]!);
    if (!email) return null;
    const name = cleanName(angle[1]!);
    const nameIsAddress = name !== null && name.replace(/^<|>$/g, "").toLowerCase() === email;
    return { email, name: nameIsAddress ? null : name };
  }
  // Bare address, possibly with a trailing (comment) used as a name.
  const comment = part.match(/^([^\s()]+)\s*\(([^)]*)\)\s*$/);
  if (comment) {
    const email = normalizeEmailAddress(comment[1]!);
    return email ? { email, name: cleanName(comment[2]!) } : null;
  }
  const email = normalizeEmailAddress(part);
  return email ? { email, name: null } : null;
}

/** Parse a header value into unique participants (first occurrence wins). */
export function parseAddressList(value: string | null | undefined): EmailParticipant[] {
  if (!value) return [];
  const seen = new Set<string>();
  const out: EmailParticipant[] = [];
  for (const raw of splitTopLevel(value)) {
    const p = parseOne(raw);
    if (p && !seen.has(p.email)) {
      seen.add(p.email);
      out.push(p);
      if (out.length >= MAX_PARTICIPANTS) break;
    }
  }
  return out;
}
