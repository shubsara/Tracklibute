import { type AuthContext, hasRole } from "@/domain/auth/auth-context";

import { type ActionDefinition, getActionDefinition } from "./registry";

/**
 * Pure policy checks — no I/O. Server services call these and then the
 * database enforces the same approval rules again.
 */
export type PolicyResult =
  | { ok: true; definition: ActionDefinition; payload: unknown }
  | { ok: false; reason: string; issues?: string[] };

/** Validate a proposal (from AI, system, or user) against the closed registry. */
export function validateProposal(auth: AuthContext, actionType: string, payload: unknown): PolicyResult {
  const definition = getActionDefinition(actionType);
  if (!definition) return { ok: false, reason: `Unknown action type "${actionType}"` };
  if (!hasRole(auth, definition.minRole)) {
    return { ok: false, reason: `Role ${auth.role} may not propose ${definition.type}` };
  }
  const parsed = definition.payloadSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Invalid payload for ${definition.type}`,
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  return { ok: true, definition, payload: parsed.data };
}

export type ExecutionStatus =
  | "PROPOSED"
  | "APPROVED"
  | "REJECTED"
  | "EXECUTING"
  | "EXECUTED"
  | "FAILED"
  | "CANCELLED";

/** Decide whether a stored proposed action may start executing. */
export function canStartExecution(action: {
  status: ExecutionStatus;
  requiresApproval: boolean;
}): { ok: true } | { ok: false; reason: string; kind: "approval_required" | "invalid_state" } {
  if (action.status === "APPROVED") return { ok: true };
  if (action.status === "PROPOSED") {
    return action.requiresApproval
      ? { ok: false, kind: "approval_required", reason: "This action requires human approval before execution" }
      : { ok: true };
  }
  return { ok: false, kind: "invalid_state", reason: `Action is ${action.status} and cannot be executed` };
}
