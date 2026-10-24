import type { HealthState } from "@/domain/opportunity-health/detector";

const STYLE: Record<HealthState, string> = {
  HEALTHY: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  NEEDS_ATTENTION: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  AT_RISK: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};
const LABEL: Record<HealthState, string> = { HEALTHY: "Healthy", NEEDS_ATTENTION: "Needs attention", AT_RISK: "At risk" };

/** Deterministic health state (no score). */
export function HealthBadge({ state }: { state: HealthState | null }) {
  if (!state) return <span className="rounded px-2 py-0.5 text-xs text-neutral-500">Not evaluated</span>;
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${STYLE[state]}`}>{LABEL[state]}</span>;
}

export const REASON_LABEL: Record<string, string> = {
  PAST_CLOSE_DATE: "Past close date",
  AWAITING_OUR_REPLY: "Buyer awaiting reply",
  AWAITING_BUYER_REPLY: "Waiting on buyer",
  INACTIVE: "Gone quiet",
  NO_NEXT_ACTIVITY: "No next step",
  UNTRACKABLE: "No contacts to track",
};
