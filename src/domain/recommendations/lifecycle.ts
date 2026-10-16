import { isEscalation } from "@/domain/opportunity-health/detector";

/**
 * Recommendation lifecycle for detector-owned recommendations (one row per
 * (responsibility, dedupe key), forever). Pure: the caller applies the result.
 *
 *   existing ╲ detection │ problem present                     │ problem gone
 *   ─────────────────────┼─────────────────────────────────────┼─────────────
 *   none                 │ create OPEN                         │ noop
 *   OPEN                 │ refresh                             │ resolve
 *   SNOOZED (active)     │ refresh                             │ resolve
 *   SNOOZED (expired)    │ reopen → OPEN                       │ resolve
 *   DISMISSED / ACCEPTED │ reopen only on escalation, else     │ resolve
 *                        │ refresh (status + fingerprint kept) │
 *   RESOLVED             │ reopen → OPEN (new episode)         │ noop
 *
 * Escalation = a worse health state or a reason code that was not present
 * when the user dismissed / accepted it.
 */
export type RecommendationStatus = "OPEN" | "ACCEPTED" | "DISMISSED" | "SNOOZED" | "RESOLVED";

export interface ExistingRecommendation {
  status: RecommendationStatus;
  fingerprint: string | null;
  snoozedUntil: Date | null;
}

export type LifecycleDecision =
  | { kind: "create" }
  | { kind: "refresh"; keepFingerprint: boolean }
  | { kind: "reopen" }
  | { kind: "resolve" }
  | { kind: "noop" };

export function decideTransition(
  existing: ExistingRecommendation | null,
  detection: { fingerprint: string } | null,
  now: Date,
): LifecycleDecision {
  if (!detection) {
    return existing && existing.status !== "RESOLVED" ? { kind: "resolve" } : { kind: "noop" };
  }
  if (!existing) return { kind: "create" };
  switch (existing.status) {
    case "OPEN":
      return { kind: "refresh", keepFingerprint: false };
    case "SNOOZED":
      return existing.snoozedUntil && existing.snoozedUntil > now
        ? { kind: "refresh", keepFingerprint: false }
        : { kind: "reopen" };
    case "DISMISSED":
    case "ACCEPTED":
      return isEscalation(existing.fingerprint, detection.fingerprint)
        ? { kind: "reopen" }
        : { kind: "refresh", keepFingerprint: true };
    case "RESOLVED":
      return { kind: "reopen" };
  }
}
