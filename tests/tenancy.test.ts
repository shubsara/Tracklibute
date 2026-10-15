import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { NotFoundError } from "@/lib/errors";
import { decideAction, executeAction, getProposedAction, proposeAction } from "@/server/actions/actions.service";
import { disconnectAppDb, getAppDb } from "@/server/db/client";
import { withOrgScope } from "@/server/db/org-scope";
import { getRecommendation, listRecommendations } from "@/server/recommendations/recommendations.service";
import {
  getResponsibility,
  listResponsibilities,
  setResponsibilityStatus,
  updateResponsibilityConfig,
} from "@/server/responsibilities/responsibilities.service";

import { closeOwnerDb, createOrgFixture, type OrgFixture, ownerDb } from "./support/fixtures";

let A: OrgFixture;
let B: OrgFixture;
let actionB: string;

beforeAll(async () => {
  A = await createOrgFixture("tenanta");
  B = await createOrgFixture("tenantb");
  const action = await proposeAction(B.members.MEMBER, {
    actionType: "gmail.send_email",
    payload: { to: ["x@y.co"], subject: "B only", bodyText: "secret B content" },
    recommendationId: B.recommendationId,
    source: "AI",
  });
  actionB = action.id;
});

afterAll(async () => {
  await disconnectAppDb();
  await closeOwnerDb();
});

describe("runtime database role", () => {
  it("is not superuser, cannot bypass RLS, and does not own tenant tables", async () => {
    const [row] = await getAppDb().$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean; owns: boolean }[]>`
      SELECT r.rolsuper, r.rolbypassrls,
             EXISTS (SELECT 1 FROM pg_tables t WHERE t.schemaname = 'public' AND t.tableowner = current_user) AS owns
      FROM pg_roles r WHERE r.rolname = current_user`;
    expect(row).toEqual({ rolsuper: false, rolbypassrls: false, owns: false });
  });
});

describe("application-level isolation: tenant A cannot READ tenant B data", () => {
  it("lists only its own responsibilities and recommendations", async () => {
    const resp = await listResponsibilities(A.members.VIEWER);
    expect(resp.length).toBeGreaterThan(0);
    expect(resp.every((r) => r.organizationId === A.organizationId)).toBe(true);
    const recs = await listRecommendations(A.members.VIEWER);
    expect(recs.map((r) => r.id)).not.toContain(B.recommendationId);
  });

  it("cannot fetch B's responsibility, recommendation or proposed action by id", async () => {
    await expect(getResponsibility(A.members.OWNER, B.responsibilityId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getRecommendation(A.members.OWNER, B.recommendationId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getProposedAction(A.members.OWNER, actionB)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("application-level isolation: tenant A cannot MODIFY tenant B data", () => {
  it("cannot change B's responsibility status or config", async () => {
    await expect(setResponsibilityStatus(A.members.OWNER, B.responsibilityId, "PAUSED")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      updateResponsibilityConfig(A.members.OWNER, B.responsibilityId, { staleAfterDays: 9 }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const b = await ownerDb().responsibility.findUniqueOrThrow({ where: { id: B.responsibilityId } });
    expect(b.status).toBe("ACTIVE");
    expect(b.config).toEqual({ firstTouchWithinHours: 24, staleAfterDays: 3 });
  });

  it("cannot approve, reject or execute B's proposed action", async () => {
    await expect(decideAction(A.members.OWNER, actionB, "APPROVED")).rejects.toBeInstanceOf(NotFoundError);
    await expect(decideAction(A.members.OWNER, actionB, "REJECTED")).rejects.toBeInstanceOf(NotFoundError);
    await expect(executeAction(A.members.OWNER, actionB)).rejects.toBeInstanceOf(NotFoundError);
    const b = await ownerDb().proposedAction.findUniqueOrThrow({ where: { id: actionB } });
    expect(b.status).toBe("PROPOSED");
    expect(await ownerDb().approval.count({ where: { proposedActionId: actionB } })).toBe(0);
  });

  it("cannot attach a proposed action to B's recommendation", async () => {
    await expect(
      proposeAction(A.members.MEMBER, {
        actionType: "recommendation.snooze",
        payload: { recommendationId: B.recommendationId, until: "2030-01-01T00:00:00Z" },
        recommendationId: B.recommendationId,
        source: "AI",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("PostgreSQL RLS (defense in depth — app filters deliberately omitted)", () => {
  it("returns no tenant rows when no organization context is set", async () => {
    const db = getAppDb();
    expect(await db.responsibility.findMany()).toEqual([]);
    expect(await db.recommendation.findMany()).toEqual([]);
    expect(await db.proposedAction.findMany()).toEqual([]);
    expect(await db.organization.findMany()).toEqual([]);
    expect(await db.auditLog.findMany()).toEqual([]);
  });

  it("an unfiltered query inside A's scope sees only A's rows", async () => {
    const rows = await withOrgScope(A.members.OWNER, async (tx) => ({
      orgs: await tx.organization.findMany(),
      responsibilities: await tx.responsibility.findMany(),
      recommendations: await tx.recommendation.findMany(),
      actions: await tx.proposedAction.findMany(),
      approvals: await tx.approval.findMany(),
      members: await tx.organizationMember.findMany(),
      audit: await tx.auditLog.findMany(),
    }));
    expect(rows.orgs.map((o) => o.id)).toEqual([A.organizationId]);
    for (const list of [rows.responsibilities, rows.recommendations, rows.actions, rows.approvals, rows.members, rows.audit]) {
      expect(list.every((r) => r.organizationId === A.organizationId)).toBe(true);
    }
    expect(rows.actions.map((a) => a.id)).not.toContain(actionB);
  });

  it("an unfiltered UPDATE / DELETE inside A's scope cannot touch B's rows", async () => {
    const result = await withOrgScope(A.members.OWNER, async (tx) => ({
      updated: await tx.responsibility.updateMany({ where: { id: B.responsibilityId }, data: { status: "ARCHIVED" } }),
      deleted: await tx.responsibility.deleteMany({ where: { id: B.responsibilityId } }),
    }));
    expect(result.updated.count).toBe(0);
    expect(result.deleted.count).toBe(0);
    expect((await ownerDb().responsibility.findUniqueOrThrow({ where: { id: B.responsibilityId } })).status).toBe(
      "ACTIVE",
    );
  });

  it("refuses to INSERT a row tagged with another organization", async () => {
    await expect(
      withOrgScope(A.members.OWNER, (tx) =>
        tx.responsibility.create({
          data: { organizationId: B.organizationId, name: "smuggled", description: "x", type: "CUSTOM" },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses cross-organization references even within A's own rows (composite FKs)", async () => {
    await expect(
      withOrgScope(A.members.OWNER, (tx) =>
        tx.recommendation.create({
          data: {
            organizationId: A.organizationId,
            responsibilityId: B.responsibilityId,
            title: "cross-link",
            summary: "x",
          },
        }),
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("only exposes users who share the current organization", async () => {
    const users = await withOrgScope(A.members.OWNER, (tx) => tx.user.findMany());
    const emails = users.map((u) => u.email);
    expect(emails).toContain(A.members.VIEWER.email);
    expect(emails).not.toContain(B.members.OWNER.email);
  });
});
