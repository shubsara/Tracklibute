import { describe, expect, it } from "vitest";

import {
  customResponsibilityConfigSchema,
  defaultConfigFor,
  parseSystemConfig,
  SYSTEM_RESPONSIBILITY_TEMPLATES,
  SYSTEM_TEMPLATE_KEYS,
} from "@/domain/responsibilities/templates";

describe("system responsibility templates", () => {
  it("defines exactly the five MVP system responsibilities", () => {
    expect(SYSTEM_TEMPLATE_KEYS.map((k) => SYSTEM_RESPONSIBILITY_TEMPLATES[k].name)).toEqual([
      "Lead Health",
      "Opportunity Health",
      "Follow-up",
      "CRM Hygiene",
      "Meeting Readiness",
    ]);
  });

  it("produces valid default configs", () => {
    for (const key of SYSTEM_TEMPLATE_KEYS) {
      expect(() => parseSystemConfig(key, defaultConfigFor(key))).not.toThrow();
    }
    expect(defaultConfigFor("lead_health")).toMatchObject({
      firstTouchWithinBusinessDays: 1,
      firstTouchEscalateAfterBusinessDays: 3,
      staleAfterDays: 3,
      escalateAfterDays: 5,
      awaitingReplyAfterBusinessDays: 2,
      awaitingReplyEscalateAfterDays: 7,
      includeMarketingQualifiedLeads: false,
    });
    // Previous pre-Lead-Health settings still parse through the compatibility key.
    expect(parseSystemConfig("lead_health", { firstTouchWithinHours: 24, staleAfterDays: 3 })).toMatchObject({
      firstTouchWithinBusinessDays: 1,
      firstTouchEscalateAfterBusinessDays: 3,
    });
  });

  it("rejects workflow-style config (triggers / conditions / steps)", () => {
    expect(() => parseSystemConfig("lead_health", { conditions: [{ field: "x" }] })).toThrow();
    expect(() => customResponsibilityConfigSchema.parse({ steps: [{ action: "send" }] })).toThrow();
    expect(() => customResponsibilityConfigSchema.parse({ trigger: "on_email" })).toThrow();
  });

  it("bounds numeric parameters", () => {
    expect(() => parseSystemConfig("opportunity_health", { inactiveAfterDays: 0 })).toThrow();
    expect(() => parseSystemConfig("opportunity_health", { inactiveAfterDays: 365 })).toThrow();
  });
});
