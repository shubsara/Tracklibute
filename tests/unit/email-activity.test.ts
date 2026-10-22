import { describe, expect, it } from "vitest";

import {
  type ActivityRules,
  type ActivitySource,
  deriveEmailActivities,
  domainMatches,
  emailDomain,
  isInternalAddress,
  normalizeDomain,
} from "@/domain/email/activity";

const rules: ActivityRules = {
  mailboxAddress: "rep@seller.io",
  internalDomains: ["seller-labs.com"],
  memberEmails: new Set(["founder@gmail.com"]),
};
const p = (email: string) => ({ email, name: "Some Name" });
const msg = (over: Partial<ActivitySource>): ActivitySource => ({
  direction: "INBOUND",
  from: p("buyer@acme.com"),
  to: [p("rep@seller.io")],
  cc: [],
  metadata: { listId: null, hasListUnsubscribe: false, precedence: null, autoSubmitted: null },
  ...over,
});

describe("deriveEmailActivities", () => {
  it("inbound: one row for the external sender, metadata only", () => {
    const rows = deriveEmailActivities(msg({}), rules);
    expect(rows).toEqual([{ direction: "INBOUND", counterpartEmail: "buyer@acme.com", counterpartDomain: "acme.com" }]);
    expect(Object.keys(rows[0]!).sort()).toEqual(["counterpartDomain", "counterpartEmail", "direction"]);
  });

  it("outbound: To + Cc external recipients, Bcc never considered, deduplicated", () => {
    const rows = deriveEmailActivities(
      msg({ direction: "OUTBOUND", from: p("rep@seller.io"), to: [p("a@acme.com"), p("a@acme.com")], cc: [p("cfo@acme.com"), p("cto@seller.io")] }),
      rules,
    );
    expect(rows.map((r) => r.counterpartEmail)).toEqual(["a@acme.com", "cfo@acme.com"]);
  });

  it("excludes internal addresses: mailbox, own domain, configured domains (+ subdomains), member emails", () => {
    const rows = deriveEmailActivities(
      msg({
        direction: "OUTBOUND",
        from: p("rep@seller.io"),
        to: [p("rep@seller.io"), p("ops@seller.io"), p("x@eu.seller-labs.com"), p("founder@gmail.com"), p("buyer@acme.com")],
      }),
      rules,
    );
    expect(rows.map((r) => r.counterpartEmail)).toEqual(["buyer@acme.com"]);
  });

  it("a public-provider mailbox does not make the whole provider internal", () => {
    const r = { ...rules, mailboxAddress: "solo@gmail.com" };
    expect(isInternalAddress("prospect@gmail.com", r)).toBe(false);
    expect(isInternalAddress("solo@gmail.com", r)).toBe(true);
  });

  it("internal-only and UNKNOWN-direction messages produce nothing", () => {
    expect(deriveEmailActivities(msg({ from: p("ops@seller.io") }), rules)).toEqual([]);
    expect(deriveEmailActivities(msg({ direction: "UNKNOWN" }), rules)).toEqual([]);
    expect(deriveEmailActivities(msg({ from: null }), rules)).toEqual([]);
  });

  it("bulk / automated mail is ineligible", () => {
    const base = { listId: null, hasListUnsubscribe: false, precedence: null, autoSubmitted: null };
    for (const metadata of [
      { ...base, listId: "<news.acme.com>" },
      { ...base, hasListUnsubscribe: true },
      { ...base, precedence: "bulk" },
      { ...base, autoSubmitted: "auto-replied" },
    ]) {
      expect(deriveEmailActivities(msg({ metadata }), rules)).toEqual([]);
    }
    expect(deriveEmailActivities(msg({ metadata: { ...base, autoSubmitted: "no" } }), rules)).toHaveLength(1);
  });
});

describe("domain helpers", () => {
  it("normalizes website-ish values and matches subdomains", () => {
    expect(normalizeDomain("https://www.Acme.io/pricing?x=1")).toBe("acme.io");
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(emailDomain("a@Sub.Acme.io")).toBe("sub.acme.io");
    expect(domainMatches("eu.acme.io", "acme.io")).toBe(true);
    expect(domainMatches("notacme.io", "acme.io")).toBe(false);
  });
});
