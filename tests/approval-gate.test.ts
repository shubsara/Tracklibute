import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ConflictError, ForbiddenError, PolicyViolationError } from "@/lib/errors";
import { decideAction, executeAction, proposeAction } from "@/server/actions/actions.service";
import type { ActionHandlers } from "@/server/actions/handlers";
import { disconnectAppDb } from "@/server/db/client";
import { withOrgScope } from "@/server/db/org-scope";

import { closeOwnerDb, connectIntegration, createOrgFixture, type OrgFixture, ownerDb } from "./support/fixtures";

let org: OrgFixture;
let sent: string[] = [];

/** Fake Gmail executor: proves the gate without any external call. */
const fakeHandlers: ActionHandlers = {
  "gmail.send_email": async ({ payload }) => {
    sent.push(payload.subject);
    return { messageId: "fake-123" };
  },
};

const email = (subject: string) => ({
  actionType: "gmail.send_email",
  payload: { to: ["buyer@prospect.co"], subject, bodyText: "Hello" },
  source: "AI" as const,
});

beforeAll(async () => {
  org = await createOrgFixture("gate");
  await connectIntegration(org.organizationId, "GMAIL");
});

afterAll(async () => {
  await disconnectAppDb();
  await closeOwnerDb();
});

const status = async (id: string) => (await ownerDb().proposedAction.findUniqueOrThrow({ where: { id } })).status;

/** Execute raw SQL as the restricted app role inside the org's RLS scope (bypasses service checks). */
const rawAsApp = (sql: string) =>
  withOrgScope(org.members.OWNER, (tx) => tx.$executeRawUnsafe(sql));

describe("approval gate — service layer", () => {
  it("non-consequential action executes without approval", async () => {
    const action = await proposeAction(org.members.MEMBER, {
      actionType: "recommendation.snooze",
      payload: { recommendationId: org.recommendationId, until: "2031-01-01T00:00:00Z" },
      recommendationId: org.recommendationId,
      source: "SYSTEM",
    });
    expect(action.requiresApproval).toBe(false);

    const done = await executeAction(org.members.MEMBER, action.id);
    expect(done.status).toBe("EXECUTED");
    const rec = await ownerDb().recommendation.findUniqueOrThrow({ where: { id: org.recommendationId } });
    expect(rec.status).toBe("SNOOZED");
  });

  it("consequential action cannot execute without approval", async () => {
    const action = await proposeAction(org.members.MEMBER, email("no approval"));
    expect(action.requiresApproval).toBe(true);
    await expect(executeAction(org.members.OWNER, action.id, fakeHandlers)).rejects.toBeInstanceOf(
      PolicyViolationError,
    );
    expect(await status(action.id)).toBe("PROPOSED");
    expect(sent).not.toContain("no approval");
  });

  it("rejected action cannot execute", async () => {
    const action = await proposeAction(org.members.MEMBER, email("rejected"));
    const rejected = await decideAction(org.members.ADMIN, action.id, "REJECTED", "wrong tone");
    expect(rejected.status).toBe("REJECTED");
    await expect(executeAction(org.members.OWNER, action.id, fakeHandlers)).rejects.toBeInstanceOf(ConflictError);
    await expect(decideAction(org.members.OWNER, action.id, "APPROVED")).rejects.toBeInstanceOf(ConflictError);
    expect(await status(action.id)).toBe("REJECTED");
    expect(sent).not.toContain("rejected");
  });

  it("approved action proceeds to execution", async () => {
    const action = await proposeAction(org.members.MEMBER, email("approved"));
    await decideAction(org.members.MEMBER, action.id, "APPROVED");
    const done = await executeAction(org.members.MEMBER, action.id, fakeHandlers);
    expect(done.status).toBe("EXECUTED");
    expect(done.result).toEqual({ messageId: "fake-123" });
    expect(done.executedAt).not.toBeNull();
    expect(sent).toContain("approved");

    const events = await ownerDb().auditLog.findMany({
      where: { entityId: action.id },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => e.event)).toEqual([
      "proposed_action.created",
      "proposed_action.approved",
      "proposed_action.execution_started",
      "proposed_action.executed",
    ]);
  });

  it("already executed action cannot be executed again", async () => {
    const action = await proposeAction(org.members.MEMBER, email("once"));
    await decideAction(org.members.OWNER, action.id, "APPROVED");
    await executeAction(org.members.OWNER, action.id, fakeHandlers);
    sent = [];
    await expect(executeAction(org.members.OWNER, action.id, fakeHandlers)).rejects.toBeInstanceOf(ConflictError);
    expect(sent).toEqual([]);
  });

  it("concurrent execution attempts run the handler exactly once", async () => {
    const action = await proposeAction(org.members.MEMBER, email("race"));
    await decideAction(org.members.OWNER, action.id, "APPROVED");
    sent = [];
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => executeAction(org.members.OWNER, action.id, fakeHandlers)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(sent).toEqual(["race"]);
    expect(await status(action.id)).toBe("EXECUTED");
  });

  it("a failing handler ends in FAILED and cannot be retried", async () => {
    const action = await proposeAction(org.members.MEMBER, email("boom"));
    await decideAction(org.members.OWNER, action.id, "APPROVED");
    const failing: ActionHandlers = {
      "gmail.send_email": async () => {
        throw new Error("provider down");
      },
    };
    const res = await executeAction(org.members.OWNER, action.id, failing);
    expect(res.status).toBe("FAILED");
    expect(res.error).toBe("provider down");
    await expect(executeAction(org.members.OWNER, action.id, fakeHandlers)).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses approved actions with no executor yet (Foundation ships no Gmail executor)", async () => {
    const action = await proposeAction(org.members.MEMBER, email("no executor"));
    await decideAction(org.members.OWNER, action.id, "APPROVED");
    await expect(executeAction(org.members.OWNER, action.id)).rejects.toThrow(/No executor/);
    expect(await status(action.id)).toBe("APPROVED");
  });

  it("refuses execution when the provider is not connected", async () => {
    const other = await createOrgFixture("gatenoconn");
    const action = await proposeAction(other.members.MEMBER, email("unconnected"));
    await decideAction(other.members.OWNER, action.id, "APPROVED");
    await expect(executeAction(other.members.OWNER, action.id, fakeHandlers)).rejects.toThrow(/not connected/);
  });

  it("VIEWER cannot propose, approve or execute", async () => {
    const action = await proposeAction(org.members.MEMBER, email("viewer"));
    await expect(proposeAction(org.members.VIEWER, email("by viewer"))).rejects.toThrow(/may not propose/);
    await expect(decideAction(org.members.VIEWER, action.id, "APPROVED")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(executeAction(org.members.VIEWER, action.id, fakeHandlers)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects proposals for unknown action types (AI cannot invent actions)", async () => {
    await expect(
      proposeAction(org.members.OWNER, {
        actionType: "http.request",
        payload: { method: "POST", url: "https://api.hubapi.com/anything" },
        source: "AI",
      }),
    ).rejects.toThrow(/Unknown action type/);
  });
});

describe("approval gate — database enforcement (bypassing the service layer)", () => {
  it("blocks PROPOSED → EXECUTING / EXECUTED for a consequential action without approval", async () => {
    const action = await proposeAction(org.members.MEMBER, email("db bypass"));
    await expect(rawAsApp(`UPDATE proposed_actions SET status='EXECUTING' WHERE id='${action.id}'`)).rejects.toThrow(
      /requires approval/,
    );
    await expect(rawAsApp(`UPDATE proposed_actions SET status='EXECUTED' WHERE id='${action.id}'`)).rejects.toThrow(
      /illegal proposed action transition/,
    );
    await expect(rawAsApp(`UPDATE proposed_actions SET status='APPROVED' WHERE id='${action.id}'`)).rejects.toThrow(
      /without an APPROVED approval record/,
    );
    expect(await status(action.id)).toBe("PROPOSED");
  });

  it("blocks downgrading requires_approval or editing the payload after creation", async () => {
    const action = await proposeAction(org.members.MEMBER, email("immutable"));
    await expect(
      rawAsApp(`UPDATE proposed_actions SET requires_approval=false WHERE id='${action.id}'`),
    ).rejects.toThrow(/immutable/);
    await expect(
      rawAsApp(`UPDATE proposed_actions SET payload='{"to":["attacker@evil.co"]}' WHERE id='${action.id}'`),
    ).rejects.toThrow(/immutable/);
  });

  it("blocks creating an action directly in an executed state", async () => {
    await expect(
      rawAsApp(
        `INSERT INTO proposed_actions (organization_id, action_type, payload, requires_approval, status, source, updated_at)
         VALUES ('${org.organizationId}', 'gmail.send_email', '{}', true, 'EXECUTED', 'AI', now())`,
      ),
    ).rejects.toThrow(/must be created in PROPOSED/);
  });

  it("blocks re-executing a terminal action at the database level", async () => {
    const action = await proposeAction(org.members.MEMBER, email("db terminal"));
    await decideAction(org.members.OWNER, action.id, "APPROVED");
    await executeAction(org.members.OWNER, action.id, fakeHandlers);
    await expect(rawAsApp(`UPDATE proposed_actions SET status='EXECUTING' WHERE id='${action.id}'`)).rejects.toThrow(
      /terminal status EXECUTED/,
    );
  });

  it("blocks rejected → approved by inserting a second approval", async () => {
    const action = await proposeAction(org.members.MEMBER, email("second approval"));
    await decideAction(org.members.OWNER, action.id, "REJECTED");
    await expect(
      rawAsApp(
        `INSERT INTO approvals (organization_id, proposed_action_id, decision, decided_by_user_id)
         VALUES ('${org.organizationId}', '${action.id}', 'APPROVED', '${org.members.OWNER.userId}')`,
      ),
    ).rejects.toThrow(/can no longer be decided|unique/i);
  });

  it("blocks approvals by VIEWERs or non-members", async () => {
    const action = await proposeAction(org.members.MEMBER, email("viewer approval"));
    await expect(
      rawAsApp(
        `INSERT INTO approvals (organization_id, proposed_action_id, decision, decided_by_user_id)
         VALUES ('${org.organizationId}', '${action.id}', 'APPROVED', '${org.members.VIEWER.userId}')`,
      ),
    ).rejects.toThrow(/not allowed to decide/);
  });

  it("approvals and audit logs are immutable", async () => {
    const action = await proposeAction(org.members.MEMBER, email("immutable approval"));
    await decideAction(org.members.OWNER, action.id, "APPROVED");
    await expect(rawAsApp(`UPDATE approvals SET decision='REJECTED' WHERE proposed_action_id='${action.id}'`)).rejects.toThrow(
      /permission denied|append-only/,
    );
    await expect(rawAsApp(`DELETE FROM approvals WHERE proposed_action_id='${action.id}'`)).rejects.toThrow(
      /permission denied|append-only/,
    );
    await expect(rawAsApp(`DELETE FROM audit_logs WHERE entity_id='${action.id}'`)).rejects.toThrow(
      /permission denied|append-only/,
    );
    // Even the schema owner cannot rewrite history.
    await expect(
      ownerDb().$executeRawUnsafe(`UPDATE audit_logs SET event='x' WHERE entity_id='${action.id}'`),
    ).rejects.toThrow(/append-only/);
  });
});
