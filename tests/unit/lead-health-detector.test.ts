import { describe, expect, it } from "vitest";

import {
  businessDaysBetween,
  evaluateLead,
  type LeadFacts,
  type LeadHealthConfig,
} from "@/domain/lead-health/detector";

const NOW = new Date("2026-10-30T12:00:00Z"); // Friday
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const ahead = (days: number) => new Date(NOW.getTime() + days * 86_400_000);
const config: LeadHealthConfig = {
  firstTouchWithinBusinessDays: 1,
  staleAfterDays: 3,
  escalateAfterDays: 5,
  firstTouchEscalateAfterBusinessDays: 3,
  awaitingReplyAfterBusinessDays: 2,
  awaitingReplyEscalateAfterDays: 7,
  includeMarketingQualifiedLeads: false,
};
const healthy: LeadFacts = {
  qualificationAt: ago(5),
  lastInboundAt: ago(2),
  lastOutboundAt: ago(1),
  crmLastActivityAt: ago(1),
  crmLastContactedAt: ago(1),
  nextActivityAt: ahead(2),
};
const codes = (facts: Partial<LeadFacts>, now = NOW) =>
  evaluateLead({ ...healthy, ...facts }, config, now).reasons.map((r) => `${r.code}:${r.state}`);

describe("business-day counting", () => {
  it("does not count Saturdays or Sundays", () => {
    expect(businessDaysBetween(new Date("2026-10-23T12:00:00Z"), new Date("2026-10-28T12:00:00Z"))).toBe(3);
  });
});

describe("evaluateLead", () => {
  it("flags a qualified lead with no first touch after one business day and escalates after three", () => {
    expect(codes({ qualificationAt: new Date("2026-10-29T12:00:00Z"), lastInboundAt: null, lastOutboundAt: null, crmLastContactedAt: null, crmLastActivityAt: null, nextActivityAt: null })).toEqual([]);
    expect(codes({ qualificationAt: new Date("2026-10-28T12:00:00Z"), lastInboundAt: null, lastOutboundAt: null, crmLastContactedAt: null, crmLastActivityAt: null, nextActivityAt: null })).toEqual(["NO_FIRST_TOUCH:NEEDS_ATTENTION"]);
    expect(codes({ qualificationAt: new Date("2026-10-20T12:00:00Z"), lastInboundAt: null, lastOutboundAt: null, crmLastContactedAt: null, crmLastActivityAt: null, nextActivityAt: null })).toEqual(["NO_FIRST_TOUCH:AT_RISK"]);
  });

  it("uses the prospect's latest reply direction and calendar-day escalation", () => {
    expect(codes({ lastInboundAt: ago(4), lastOutboundAt: ago(6), nextActivityAt: null })).toEqual(["AWAITING_OUR_REPLY:NEEDS_ATTENTION"]);
    expect(codes({ lastInboundAt: ago(9), lastOutboundAt: ago(12), nextActivityAt: null })).toEqual(["AWAITING_OUR_REPLY:AT_RISK"]);
    expect(codes({ lastInboundAt: ago(5), lastOutboundAt: ago(3), nextActivityAt: null })).toEqual(["AWAITING_BUYER_REPLY:NEEDS_ATTENTION"]);
  });

  it("general inactivity is needs-attention after three business days and at-risk after five", () => {
    expect(codes({ lastInboundAt: ago(5), lastOutboundAt: ago(5), crmLastActivityAt: ago(5), crmLastContactedAt: ago(5), nextActivityAt: null })).toEqual(["INACTIVE:NEEDS_ATTENTION"]);
    expect(codes({ lastInboundAt: ago(8), lastOutboundAt: ago(8), crmLastActivityAt: ago(8), crmLastContactedAt: ago(8), nextActivityAt: null })).toEqual(["INACTIVE:AT_RISK"]);
  });

  it("does not flag general inactivity when a future next activity is scheduled", () => {
    expect(codes({ lastInboundAt: ago(10), lastOutboundAt: ago(11), crmLastActivityAt: ago(10), nextActivityAt: ahead(1) })).toEqual([]);
    expect(codes({ qualificationAt: ago(9), lastInboundAt: null, lastOutboundAt: null, crmLastContactedAt: null, crmLastActivityAt: null, nextActivityAt: ahead(1) })).toEqual([]);
  });

  it("does not invent a first-touch deadline when qualification timestamp is missing", () => {
    expect(codes({ qualificationAt: null, lastInboundAt: null, lastOutboundAt: null, crmLastContactedAt: null, crmLastActivityAt: null, nextActivityAt: null })).toEqual([]);
  });

  it("does not put email content in detector output", () => {
    const result = evaluateLead(healthy, config, NOW);
    expect(JSON.stringify(result)).not.toMatch(/subject|body|snippet/i);
  });
});
