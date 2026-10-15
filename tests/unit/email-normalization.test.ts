import { describe, expect, it } from "vitest";

import { capBody, EMAIL_BODY_MAX_CHARS, htmlToText, normalizeBody } from "@/domain/email/body";
import { buildEmailContext } from "@/domain/email/context";
import { determineDirection } from "@/domain/email/direction";
import { decodeEncodedWords, normalizeEmailAddress, parseAddressList } from "@/domain/email/participants";

describe("participants", () => {
  it("parses common address forms and lowercases emails", () => {
    expect(
      parseAddressList(`Jane Doe <Jane.Doe@Acme.COM>, "Smith, Bob" <bob@x.io>, plain@y.dev, carl@z.io (Carl Z)`),
    ).toEqual([
      { email: "jane.doe@acme.com", name: "Jane Doe" },
      { email: "bob@x.io", name: "Smith, Bob" },
      { email: "plain@y.dev", name: null },
      { email: "carl@z.io", name: "Carl Z" },
    ]);
  });

  it("tolerates missing names, groups, duplicates and malformed entries", () => {
    expect(parseAddressList("undisclosed-recipients:;")).toEqual([]);
    expect(parseAddressList("Team: a@b.co, c@d.co;")).toEqual([
      { email: "a@b.co", name: null },
      { email: "c@d.co", name: null },
    ]);
    expect(parseAddressList("not-an-email, <also bad>, ok@ok.io, OK@ok.io")).toEqual([{ email: "ok@ok.io", name: null }]);
    expect(parseAddressList("")).toEqual([]);
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList(`"<ok@ok.io>" <ok@ok.io>`)).toEqual([{ email: "ok@ok.io", name: null }]);
  });

  it("decodes RFC 2047 encoded names", () => {
    expect(decodeEncodedWords("=?UTF-8?B?SsO8cmdlbg==?=")).toBe("Jürgen");
    expect(decodeEncodedWords("=?ISO-8859-1?Q?Andr=E9_P?=")).toBe("André P");
    expect(parseAddressList("=?UTF-8?Q?Zo=C3=AB?= <zoe@x.io>")).toEqual([{ email: "zoe@x.io", name: "Zoë" }]);
  });

  it("rejects invalid addresses", () => {
    expect(normalizeEmailAddress("no-at-sign")).toBeNull();
    expect(normalizeEmailAddress("a@b")).toBeNull();
    expect(normalizeEmailAddress(" MAILTO:Sam@X.io ")).toBe("sam@x.io");
  });
});

describe("direction", () => {
  const me = "rep@acme.com";
  it("uses the sender relative to the mailbox", () => {
    expect(determineDirection({ email: "rep@acme.com", name: null }, "Rep@Acme.com", ["SENT"])).toBe("OUTBOUND");
    expect(determineDirection({ email: "buyer@x.io", name: null }, me, ["INBOX"])).toBe("INBOUND");
  });
  it("is UNKNOWN when ambiguous", () => {
    expect(determineDirection(null, me, ["INBOX"])).toBe("UNKNOWN");
    expect(determineDirection({ email: "alias@acme.com", name: null }, me, ["SENT"])).toBe("UNKNOWN");
  });
  it("does not infer direction from labels alone", () => {
    expect(determineDirection({ email: "buyer@x.io", name: null }, me, [])).toBe("INBOUND");
    expect(determineDirection({ email: me, name: null }, me, ["INBOX"])).toBe("OUTBOUND");
  });
});

describe("body normalization", () => {
  it("prefers text/plain", () => {
    expect(normalizeBody({ plain: "Hello\r\n\r\n\r\n  world  ", html: "<p>ignored</p>" })).toEqual({
      text: "Hello\n\nworld",
      truncated: false,
    });
  });

  it("falls back to HTML, dropping scripts/styles and decoding entities", () => {
    const html = `<html><head><style>p{}</style><title>t</title></head><body><script>alert(1)</script>
      <p>Hi&nbsp;Sam &amp; team,</p><ul><li>One</li><li>Two</li></ul><p>Price &lt;$5&gt; &#8212; ok&#x21;</p></body></html>`;
    expect(normalizeBody({ plain: null, html }).text).toBe("Hi Sam & team,\n\n- One\n- Two\n\nPrice <$5> — ok!");
    expect(htmlToText("<a href='x'>link</a><br>next")).toBe("link\nnext");
  });

  it("returns null for missing or empty bodies", () => {
    expect(normalizeBody({ plain: null, html: null })).toEqual({ text: null, truncated: false });
    expect(normalizeBody({ plain: "   ", html: "<p> </p>" })).toEqual({ text: null, truncated: false });
  });

  it("caps stored size", () => {
    const res = normalizeBody({ plain: "x".repeat(EMAIL_BODY_MAX_CHARS + 10), html: null });
    expect(res.text).toHaveLength(EMAIL_BODY_MAX_CHARS);
    expect(res.truncated).toBe(true);
    expect(capBody("short")).toEqual({ text: "short", truncated: false });
  });
});

describe("NormalizedEmailContext", () => {
  it("summarizes a thread without exposing provider types", () => {
    const t = (s: string) => new Date(s);
    const ctx = buildEmailContext(
      { id: "t1", subject: "Pricing" },
      [
        { id: "m2", from: { email: "rep@acme.com", name: "Rep" }, to: [{ email: "buyer@x.io", name: null }], cc: [], direction: "OUTBOUND", sentAt: null, receivedAt: t("2026-10-02"), subject: "Re: Pricing", bodyText: "b" },
        { id: "m1", from: { email: "buyer@x.io", name: "Buyer" }, to: [{ email: "rep@acme.com", name: null }], cc: [{ email: "cfo@x.io", name: null }], direction: "INBOUND", sentAt: null, receivedAt: t("2026-10-01"), subject: "Pricing", bodyText: "a" },
      ],
      "rep@acme.com",
    );
    expect(ctx.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(ctx.participants).toEqual([
      { email: "buyer@x.io", name: "Buyer" },
      { email: "cfo@x.io", name: null },
    ]);
    expect(ctx).toMatchObject({ messageCount: 2, lastDirection: "OUTBOUND", inboundCount: 1, outboundCount: 1 });
    expect(ctx.firstActivityAt).toEqual(t("2026-10-01"));
    expect(ctx.lastActivityAt).toEqual(t("2026-10-02"));
  });
});
