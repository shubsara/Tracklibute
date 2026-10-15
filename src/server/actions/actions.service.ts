import "server-only";

import type { Prisma, ProposedAction } from "@/generated/prisma/client";
import { canStartExecution, validateProposal } from "@/domain/actions/policy";
import { getActionDefinition, isActionType } from "@/domain/actions/registry";
import { type AuthContext, requireRole } from "@/domain/auth/auth-context";
import { ConflictError, NotFoundError, PolicyViolationError, ValidationError } from "@/lib/errors";
import { recordAudit } from "@/server/audit/audit-log";
import { type Tx, withOrgScope } from "@/server/db/org-scope";

import { type ActionHandler, type ActionHandlers, defaultActionHandlers } from "./handlers";

export interface ProposeActionInput {
  actionType: string;
  payload: unknown;
  recommendationId?: string;
  /** Who produced the proposal. AI output enters here and ONLY here. */
  source: "SYSTEM" | "AI" | "USER";
}

/**
 * Step 1 — Propose. Validates against the closed registry; the approval
 * requirement is copied from the registry (the proposer cannot choose it).
 */
export async function proposeAction(auth: AuthContext, input: ProposeActionInput): Promise<ProposedAction> {
  const policy = validateProposal(auth, input.actionType, input.payload);
  if (!policy.ok) throw new ValidationError(policy.reason, policy.issues);

  return withOrgScope(auth, async (tx) => {
    if (input.recommendationId) {
      const rec = await tx.recommendation.findFirst({
        where: { id: input.recommendationId, organizationId: auth.organizationId },
        select: { id: true },
      });
      if (!rec) throw new NotFoundError("Recommendation not found");
    }
    const action = await tx.proposedAction.create({
      data: {
        organizationId: auth.organizationId,
        recommendationId: input.recommendationId ?? null,
        actionType: policy.definition.type,
        payload: policy.payload as Prisma.InputJsonValue,
        requiresApproval: policy.definition.consequential,
        source: input.source,
        createdByUserId: auth.userId,
      },
    });
    await recordAudit(tx, auth, {
      event: "proposed_action.created",
      entityType: "proposed_action",
      entityId: action.id,
      metadata: { actionType: action.actionType, source: input.source, requiresApproval: action.requiresApproval },
    });
    return action;
  });
}

async function loadAction(tx: Tx, auth: AuthContext, id: string): Promise<ProposedAction> {
  const action = await tx.proposedAction.findFirst({ where: { id, organizationId: auth.organizationId } });
  if (!action) throw new NotFoundError("Proposed action not found");
  return action;
}

/**
 * Step 2 — Human decision. Writes an immutable Approval record and moves the
 * action to APPROVED / REJECTED in the same transaction.
 */
export async function decideAction(
  auth: AuthContext,
  actionId: string,
  decision: "APPROVED" | "REJECTED",
  reason?: string,
): Promise<ProposedAction> {
  requireRole(auth, "MEMBER");
  return withOrgScope(auth, async (tx) => {
    const action = await loadAction(tx, auth, actionId);
    const definition = getActionDefinition(action.actionType);
    if (definition) requireRole(auth, definition.minRole);
    if (action.status !== "PROPOSED") {
      throw new ConflictError(`Action is ${action.status} and can no longer be decided`);
    }

    await tx.approval.create({
      data: {
        organizationId: auth.organizationId,
        proposedActionId: action.id,
        decision,
        decidedByUserId: auth.userId,
        reason: reason ?? null,
      },
    });
    const updated = await tx.proposedAction.update({
      where: { id: action.id },
      data: { status: decision },
    });
    await recordAudit(tx, auth, {
      event: decision === "APPROVED" ? "proposed_action.approved" : "proposed_action.rejected",
      entityType: "proposed_action",
      entityId: action.id,
      metadata: { actionType: action.actionType, reason: reason ?? null },
    });
    return updated;
  });
}

/**
 * Step 3 — Execute. Re-validates against the registry, checks policy, then
 * atomically claims the action (→ EXECUTING) with a conditional update. The
 * database independently refuses the claim for a consequential action without
 * an APPROVED record. The handler runs outside the transaction; the outcome
 * is recorded as EXECUTED or FAILED. A terminal action can never run again.
 */
export async function executeAction(
  auth: AuthContext,
  actionId: string,
  handlers: ActionHandlers = defaultActionHandlers,
): Promise<ProposedAction> {
  requireRole(auth, "MEMBER");

  const { action, payload, handler } = await withOrgScope(auth, async (tx) => {
    const action = await loadAction(tx, auth, actionId);

    if (!isActionType(action.actionType)) {
      throw new PolicyViolationError(`Action type "${action.actionType}" is not registered`);
    }
    const definition = getActionDefinition(action.actionType)!;
    requireRole(auth, definition.minRole);

    // Registry drift guard: never execute with a weaker approval requirement than the registry demands.
    if (definition.consequential && !action.requiresApproval) {
      throw new PolicyViolationError("Stored approval requirement is weaker than the registry; refusing");
    }

    const gate = canStartExecution(action);
    if (!gate.ok) {
      if (gate.kind === "approval_required") throw new PolicyViolationError(gate.reason);
      throw new ConflictError(gate.reason);
    }

    const parsed = definition.payloadSchema.safeParse(action.payload);
    if (!parsed.success) throw new PolicyViolationError("Stored payload no longer satisfies the registry schema");

    const handler = handlers[action.actionType] as ActionHandler | undefined;
    if (!handler) {
      throw new PolicyViolationError(`No executor is available for ${action.actionType} yet`);
    }

    if (definition.provider) {
      const connected = await tx.integration.findFirst({
        where: { organizationId: auth.organizationId, provider: definition.provider, status: "CONNECTED" },
        select: { id: true },
      });
      if (!connected) throw new PolicyViolationError(`${definition.provider} is not connected`);
    }

    // Atomic claim: only one caller can move PROPOSED/APPROVED → EXECUTING.
    const { count } = await tx.proposedAction.updateMany({
      where: { id: action.id, organizationId: auth.organizationId, status: action.status },
      data: { status: "EXECUTING" },
    });
    if (count === 0) throw new ConflictError("Action was modified concurrently");

    await recordAudit(tx, auth, {
      event: "proposed_action.execution_started",
      entityType: "proposed_action",
      entityId: action.id,
      metadata: { actionType: action.actionType },
    });
    return { action, payload: parsed.data, handler };
  });

  let outcome: { ok: true; result: Prisma.InputJsonValue } | { ok: false; error: string };
  try {
    outcome = { ok: true, result: await handler({ auth, actionId: action.id, payload: payload as never }) };
  } catch (err) {
    outcome = { ok: false, error: err instanceof Error ? err.message.slice(0, 1000) : "Execution failed" };
  }

  return withOrgScope(auth, async (tx) => {
    const updated = await tx.proposedAction.update({
      where: { id: action.id },
      data: outcome.ok
        ? { status: "EXECUTED", result: outcome.result, executedAt: new Date() }
        : { status: "FAILED", error: outcome.error },
    });
    await recordAudit(tx, auth, {
      event: outcome.ok ? "proposed_action.executed" : "proposed_action.failed",
      entityType: "proposed_action",
      entityId: action.id,
      metadata: { actionType: action.actionType },
    });
    return updated;
  });
}

export async function getProposedAction(auth: AuthContext, id: string): Promise<ProposedAction> {
  return withOrgScope(auth, (tx) => loadAction(tx, auth, id));
}

export async function listProposedActions(auth: AuthContext): Promise<ProposedAction[]> {
  return withOrgScope(auth, (tx) =>
    tx.proposedAction.findMany({
      where: { organizationId: auth.organizationId },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  );
}
