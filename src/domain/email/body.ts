/**
 * Small, deterministic body normalizer. No AI, no summarization — the output
 * is raw source context (and remains untrusted content).
 *
 *   1. prefer text/plain; 2. fall back to text/html → text;
 *   3. strip markup; 4. normalize whitespace; 5. cap length.
 */
export const EMAIL_BODY_MAX_CHARS = 50_000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", bull: "•",
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1]?.toLowerCase() === "x" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/?(p|div|h[1-6]|tr|table|blockquote|section|article|header|footer|ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<\/(td|th)\s*>/gi, "\t")
    .replace(/<[^>]+>/g, "");
  return decodeHtmlEntities(text);
}

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/[​-‍﻿]/g, "")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function capBody(text: string, max = EMAIL_BODY_MAX_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

/** Choose and normalize the body from already-decoded MIME candidates. */
export function normalizeBody(candidates: { plain: string | null; html: string | null }): {
  text: string | null;
  truncated: boolean;
} {
  const source =
    candidates.plain && candidates.plain.trim()
      ? candidates.plain
      : candidates.html && candidates.html.trim()
        ? htmlToText(candidates.html)
        : null;
  if (source === null) return { text: null, truncated: false };
  const normalized = normalizeWhitespace(source);
  if (!normalized) return { text: null, truncated: false };
  return capBody(normalized);
}
