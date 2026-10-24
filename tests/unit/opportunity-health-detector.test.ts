import { describe, expect, it } from "vitest";

import {
  type DealFacts,
  describeEvaluation,
  evaluateDeal,
  healthFingerprint,
  isEscalation,
  type OpportunityHealthConfig,
} from "@/domain/opportunity-health/detector";
import { assertMetadataOnlyEvidence } from "@/domain/opportunity-health/evidence";
import { defaultConfigFor, parseSystemConfig, SYSTEM_RESPONSIBILITY_TEMPLATES } from "@/domain/responsibilities/templates";

const NOW = new Date("2026-10-16T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const ahead = (days: number) => new Date(NOW.getTime() + days * 86_400_000);
const config: OpportunityHealthConfig = { inactiveAfterDays: 7, flagPastCloseDate: true, awaitingReplyAfterDays: 2, flagMissingNextActivity: true };
const healthy: DealFacts = {
  closeDate: ahead(30),
  externalCreatedAt: ago(60),
  crmLastActivityAt: ago(1),
  nextActivityAt: ahead(3),
  lastInboundAt: ago(2),
  lastOutboundAt: ago(1),
  trackable: true,
};
const codes = (f: Partial<DealFacts>, c = config) => evaluateDeal({ ...healthy, ...f }, c, NOW).reasons.map((r) => `${r.code}:${r.state}`);

describe("template", () => {
  it("Opportunity Health needs HubSpot + Gmail only (Calendar deferred) and has deterministic config", () => {
    expect(SYSTEM_RESPONSIBILITY_TEMPLATES.opportunity_health.requiredProviders).toEqual(["HUBSPOT", "GMAIL"]);
    expect(defaultConfigFor("opportunity_health")).toEqual(config);
    // Pre-Spec-03 stored configs still parse (new keys default).
    expect(parseSystemConfig("opportunity_health", { inactiveAfterDays: 10, flagPastCloseDate: false })).toMatchObject({ inactiveAfterDays: 10, awaitingReplyAfterDays: 2 });
    expect(() => parseSystemConfig("opportunity_health", { score: 50 })).toThrow();
  });
});

describe("evaluateDeal", () => {
  it("HEALTHY when nothing is wrong — no score anywhere", () => {
    const e = evaluateDeal(healthy, config, NOW);
    expect(e).toMatchObject({ state: "HEALTHY", reasons: [] });
    expect(JSON.stringify(e)).not.toMatch(/score/i);
  });

  it("PAST_CLOSE_DATE → AT_RISK (only when enabled; today is not past)", () => {
    expect(codes({ closeDate: ago(3) })).toEqual(["PAST_CLOSE_DATE:AT_RISK"]);
    expect(codes({ closeDate: new Date("2026-10-16T00:00:00Z") })).toEqual([]);
    expect(codes({ closeDate: ago(3) }, { ...config, flagPastCloseDate: false })).toEqual([]);
  });

  it("missing close date is NOT an Opportunity Health reason (CRM Hygiene's job)", () => {
    expect(codes({ closeDate: null })).toEqual([]);
  });

  it("INACTIVE thresholds: > N days NEEDS_ATTENTION, > 2N AT_RISK; latest of email and CRM activity counts", () => {
    expect(codes({ lastInboundAt: ago(8), lastOutboundAt: ago(8), crmLastActivityAt: ago(9) })).toEqual(["INACTIVE:NEEDS_ATTENTION"]);
    expect(codes({ lastInboundAt: ago(20), lastOutboundAt: ago(15), crmLastActivityAt: null })).toEqual(["INACTIVE:AT_RISK"]);
    expect(codes({ lastInboundAt: null, lastOutboundAt: ago(30), crmLastActivityAt: ago(2) })).toEqual([]);
    expect(codes({ lastInboundAt: ago(7), lastOutboundAt: ago(7), crmLastActivityAt: null })).toEqual([]); // boundary: exactly N days
  });

  it("no activity ever on a deal older than N days → AT_RISK; a brand-new deal is fine", () => {
    const none = { lastInboundAt: null, lastOutboundAt: null, crmLastActivityAt: null };
    expect(codes({ ...none, externalCreatedAt: ago(10) })).toEqual(["INACTIVE:AT_RISK"]);
    expect(codes({ ...none, externalCreatedAt: ago(2) })).toEqual([]);
  });

  it("AWAITING_OUR_REPLY when the buyer wrote last and it's unanswered", () => {
    expect(codes({ lastInboundAt: ago(3), lastOutboundAt: ago(5), crmLastActivityAt: ago(3) })).toEqual(["AWAITING_OUR_REPLY:NEEDS_ATTENTION"]);
    expect(codes({ lastInboundAt: ago(1), lastOutboundAt: ago(5), crmLastActivityAt: ago(1) })).toEqual([]);
    expect(codes({ lastInboundAt: ago(9), lastOutboundAt: null, crmLastActivityAt: ago(1) })).toEqual(["AWAITING_OUR_REPLY:AT_RISK"]);
  });

  it("AWAITING_BUYER_REPLY when we wrote last; a future task does not suppress it", () => {
    expect(codes({ lastInboundAt: ago(5), lastOutboundAt: ago(3) })).toEqual(["AWAITING_BUYER_REPLY:NEEDS_ATTENTION"]);
    expect(codes({ lastInboundAt: ago(5), lastOutboundAt: ago(2) })).toEqual([]); // exactly two days
    expect(codes({ lastInboundAt: ago(1), lastOutboundAt: ago(3) })).toEqual([]); // reply arrived after outbound
  });

  it("AWAITING_BUYER_REPLY escalates only after inactiveAfterDays", () => {
    expect(codes({ lastInboundAt: null, lastOutboundAt: ago(7), crmLastActivityAt: ago(1) })).toEqual(["AWAITING_BUYER_REPLY:NEEDS_ATTENTION"]);
    expect(codes({ lastInboundAt: null, lastOutboundAt: new Date(NOW.getTime() - 7 * 86_400_000 - 1), crmLastActivityAt: ago(1) })).toEqual(["AWAITING_BUYER_REPLY:AT_RISK"]);
  });

  it("NO_NEXT_ACTIVITY when nothing is scheduled or it is in the past (if enabled)", () => {
    expect(codes({ nextActivityAt: null })).toEqual(["NO_NEXT_ACTIVITY:NEEDS_ATTENTION"]);
    expect(codes({ nextActivityAt: ago(1) })).toEqual(["NO_NEXT_ACTIVITY:NEEDS_ATTENTION"]);
    expect(codes({ nextActivityAt: null }, { ...config, flagMissingNextActivity: false })).toEqual([]);
  });

  it("UNTRACKABLE when nothing can be matched", () => {
    expect(codes({ trackable: false })).toEqual(["UNTRACKABLE:NEEDS_ATTENTION"]);
  });

  it("state is the worst reason; reasons sorted worst first; deterministic", () => {
    const f = { ...healthy, closeDate: ago(1), nextActivityAt: null, trackable: false };
    const a = evaluateDeal(f, config, NOW);
    expect(a.state).toBe("AT_RISK");
    expect(a.reasons.map((r) => r.code)).toEqual(["PAST_CLOSE_DATE", "NO_NEXT_ACTIVITY", "UNTRACKABLE"]);
    expect(evaluateDeal(f, config, NOW)).toEqual(a);
    expect(healthFingerprint(a)).toBe("AT_RISK|NO_NEXT_ACTIVITY,PAST_CLOSE_DATE,UNTRACKABLE");
    expect(describeEvaluation("Acme renewal", a).title).toBe("Acme renewal is past its close date");
  });
});

describe("escalation", () => {
  it("worse state or new reason code escalates; same or better does not", () => {
    expect(isEscalation("NEEDS_ATTENTION|INACTIVE", "AT_RISK|INACTIVE")).toBe(true);
    expect(isEscalation("NEEDS_ATTENTION|INACTIVE", "NEEDS_ATTENTION|INACTIVE,NO_NEXT_ACTIVITY")).toBe(true);
    expect(isEscalation("AT_RISK|INACTIVE,PAST_CLOSE_DATE", "AT_RISK|INACTIVE")).toBe(false);
    expect(isEscalation("AT_RISK|INACTIVE", "NEEDS_ATTENTION|INACTIVE")).toBe(false);
    expect(isEscalation(null, "NEEDS_ATTENTION|INACTIVE")).toBe(true);
  });
});

describe("evidence allow-list", () => {
  const valid = {
    state: "NEEDS_ATTENTION",
    reasons: [{ code: "INACTIVE", state: "NEEDS_ATTENTION", days: 9, at: "2026-10-07T12:00:00.000Z" }],
    lastInboundAt: null,
    lastOutboundAt: null,
    lastEmailAt: null,
    crmLastActivityAt: null,
    lastActivityAt: null,
    lastTouchMailboxUserId: null,
    matchedCounterpartCount: 0,
    emailCoverage: { connectedMailboxes: 0, ownerMapped: false, ownerMailboxConnected: false, limitedSignal: true },
    deal: { id: "6f1d1c7e-2b7a-4c5e-9a43-1d3f2a7b8c9d", externalId: "123" },
  };
  it("accepts metadata and rejects any extra field (subject, snippet, body, free text)", () => {
    expect(() => assertMetadataOnlyEvidence(valid)).not.toThrow();
    for (const extra of [{ subject: "Pricing" }, { snippet: "hi" }, { bodyText: "secret" }, { note: "x" }]) {
      expect(() => assertMetadataOnlyEvidence({ ...valid, ...extra })).toThrow();
    }
    expect(() => assertMetadataOnlyEvidence({ ...valid, reasons: [{ ...valid.reasons[0], text: "x" }] })).toThrow();
    expect(() => assertMetadataOnlyEvidence({ ...valid, state: "SCORE_80" })).toThrow();
  });
});
