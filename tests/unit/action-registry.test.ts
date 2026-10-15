import { describe, expect, it } from "vitest";

import { canStartExecution, validateProposal } from "@/domain/actions/policy";
import { ACTION_REGISTRY, getActionDefinition } from "@/domain/actions/registry";
import type { AuthContext } from "@/domain/auth/auth-context";

const member: AuthContext = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  role: "MEMBER",
};
const viewer: AuthContext = { ...member, role: "VIEWER" };

describe("closed action registry", () => {
  it("contains no generic / arbitrary-execution action types", () => {
    for (const type of Object.keys(ACTION_REGISTRY)) {
      expect(type).not.toMatch(/http|request|fetch|script|code|eval|exec|webhook|custom/i);
    }
  });

  it("rejects unknown action types, including prototype keys", () => {
    expect(getActionDefinition("http.request")).toBeNull();
    expect(getActionDefinition("toString")).toBeNull();
    expect(getActionDefinition("__proto__")).toBeNull();
    expect(validateProposal(member, "http.request", { url: "https://evil.example" })).toMatchObject({ ok: false });
  });

  it("marks externally visible actions as consequential", () => {
    expect(ACTION_REGISTRY["gmail.send_email"].consequential).toBe(true);
    expect(ACTION_REGISTRY["hubspot.update_deal_stage"].consequential).toBe(true);
    expect(ACTION_REGISTRY["hubspot.create_task"].consequential).toBe(true);
    expect(ACTION_REGISTRY["google_calendar.create_event"].consequential).toBe(true);
    expect(ACTION_REGISTRY["gmail.create_draft"].consequential).toBe(false);
    expect(ACTION_REGISTRY["recommendation.snooze"].consequential).toBe(false);
  });

  it("validates payloads strictly (no smuggled fields)", () => {
    const ok = validateProposal(member, "gmail.send_email", { to: ["a@b.co"], subject: "Hi", bodyText: "Hello" });
    expect(ok.ok).toBe(true);
    const extra = validateProposal(member, "gmail.send_email", {
      to: ["a@b.co"],
      subject: "Hi",
      bodyText: "Hello",
      endpoint: "https://evil.example",
    });
    expect(extra.ok).toBe(false);
    expect(validateProposal(member, "gmail.send_email", { to: ["not-an-email"], subject: "x", bodyText: "y" }).ok).toBe(
      false,
    );
  });

  it("enforces the minimum role to propose", () => {
    const res = validateProposal(viewer, "gmail.create_draft", { to: ["a@b.co"], subject: "s", bodyText: "b" });
    expect(res).toMatchObject({ ok: false });
  });

  it("gates execution on approval state", () => {
    expect(canStartExecution({ status: "PROPOSED", requiresApproval: false }).ok).toBe(true);
    expect(canStartExecution({ status: "PROPOSED", requiresApproval: true })).toMatchObject({
      ok: false,
      kind: "approval_required",
    });
    expect(canStartExecution({ status: "APPROVED", requiresApproval: true }).ok).toBe(true);
    for (const status of ["REJECTED", "EXECUTING", "EXECUTED", "FAILED", "CANCELLED"] as const) {
      expect(canStartExecution({ status, requiresApproval: true })).toMatchObject({ ok: false, kind: "invalid_state" });
    }
  });
});
