/**
 * Opportunity Health — deterministic detector (Build Spec 03).
 *
 * A pure function of (deal facts, config, now). No AI, no scores: every open
 * deal is HEALTHY, NEEDS_ATTENTION or AT_RISK, explained by reason codes.
 * The state is the worst state among its reasons; no reasons → HEALTHY.
 *
 *   PAST_CLOSE_DATE     close date before today (if flagPastCloseDate)  → AT_RISK
 *   INACTIVE            no activity for > inactiveAfterDays             → NEEDS_ATTENTION
 *                       > 2 × inactiveAfterDays, or never any activity
 *                       on a deal older than inactiveAfterDays          → AT_RISK
 *   AWAITING_OUR_REPLY  buyer wrote last, unanswered > awaitingReplyAfterDays → NEEDS_ATTENTION
 *                       unanswered > inactiveAfterDays                  → AT_RISK
 *   AWAITING_BUYER_REPLY we wrote last, unanswered > awaitingReplyAfterDays → NEEDS_ATTENTION
 *                       unanswered > inactiveAfterDays                  → AT_RISK
 *   NO_NEXT_ACTIVITY    no future activity scheduled in the CRM
 *                       (if flagMissingNextActivity)                    → NEEDS_ATTENTION
 *   UNTRACKABLE         no contact email and no company domain to match
 *                       activity against                                → NEEDS_ATTENTION
 *
 * "Activity" = the latest of: any teammate's email with the deal's contacts /
 * company domains (content-free EmailActivity), and HubSpot's last logged
 * activity (notes_last_updated — calls, meetings, notes). Missing CRM fields
 * other than these signals belong to the future CRM Hygiene responsibility.
 */

export const HEALTH_STATES = ["HEALTHY", "NEEDS_ATTENTION", "AT_RISK"] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export const REASON_CODES = [
  "PAST_CLOSE_DATE",
  "AWAITING_OUR_REPLY",
  "AWAITING_BUYER_REPLY",
  "INACTIVE",
  "NO_NEXT_ACTIVITY",
  "UNTRACKABLE",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface OpportunityHealthConfig {
  inactiveAfterDays: number;
  flagPastCloseDate: boolean;
  awaitingReplyAfterDays: number;
  flagMissingNextActivity: boolean;
}

export interface DealFacts {
  closeDate: Date | null;
  externalCreatedAt: Date | null;
  crmLastActivityAt: Date | null;
  nextActivityAt: Date | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  /** Deal has at least one contact email or (non-public) company domain. */
  trackable: boolean;
}

export interface HealthReason {
  code: ReasonCode;
  state: Exclude<HealthState, "HEALTHY">;
  /** Whole days relevant to the reason (days inactive, days overdue, ...). */
  days?: number;
  /** The timestamp the reason is measured from. */
  at?: string;
}

export interface HealthEvaluation {
  state: HealthState;
  reasons: HealthReason[];
  lastEmailAt: Date | null;
  lastActivityAt: Date | null;
}

const DAY_MS = 86_400_000;
const RANK: Record<HealthState, number> = { HEALTHY: 0, NEEDS_ATTENTION: 1, AT_RISK: 2 };

export function stateRank(state: HealthState): number {
  return RANK[state];
}

const wholeDays = (from: Date, now: Date) => Math.floor((now.getTime() - from.getTime()) / DAY_MS);
const startOfUtcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
const latest = (...dates: (Date | null)[]): Date | null =>
  dates.reduce<Date | null>((a, b) => (b && (!a || b > a) ? b : a), null);

export function evaluateDeal(facts: DealFacts, config: OpportunityHealthConfig, now: Date): HealthEvaluation {
  const reasons: HealthReason[] = [];
  const lastEmailAt = latest(facts.lastInboundAt, facts.lastOutboundAt);
  const lastActivityAt = latest(lastEmailAt, facts.crmLastActivityAt);

  if (config.flagPastCloseDate && facts.closeDate && facts.closeDate.getTime() < startOfUtcDay(now)) {
    reasons.push({
      code: "PAST_CLOSE_DATE",
      state: "AT_RISK",
      days: Math.max(1, Math.floor((startOfUtcDay(now) - startOfUtcDay(facts.closeDate)) / DAY_MS)),
      at: facts.closeDate.toISOString(),
    });
  }

  if (
    facts.lastInboundAt &&
    (!facts.lastOutboundAt || facts.lastInboundAt > facts.lastOutboundAt) &&
    now.getTime() - facts.lastInboundAt.getTime() > config.awaitingReplyAfterDays * DAY_MS
  ) {
    const days = wholeDays(facts.lastInboundAt, now);
    reasons.push({
      code: "AWAITING_OUR_REPLY",
      state: now.getTime() - facts.lastInboundAt.getTime() > config.inactiveAfterDays * DAY_MS ? "AT_RISK" : "NEEDS_ATTENTION",
      days,
      at: facts.lastInboundAt.toISOString(),
    });
  }

  // A scheduled next step does not mean the buyer has responded. This signal
  // is based only on direction and timestamps; email content is never read.
  if (
    facts.lastOutboundAt &&
    (!facts.lastInboundAt || facts.lastOutboundAt > facts.lastInboundAt) &&
    now.getTime() - facts.lastOutboundAt.getTime() > config.awaitingReplyAfterDays * DAY_MS
  ) {
    const days = wholeDays(facts.lastOutboundAt, now);
    reasons.push({
      code: "AWAITING_BUYER_REPLY",
      state: now.getTime() - facts.lastOutboundAt.getTime() > config.inactiveAfterDays * DAY_MS ? "AT_RISK" : "NEEDS_ATTENTION",
      days,
      at: facts.lastOutboundAt.toISOString(),
    });
  }

  if (lastActivityAt) {
    const idleMs = now.getTime() - lastActivityAt.getTime();
    if (idleMs > config.inactiveAfterDays * DAY_MS) {
      reasons.push({
        code: "INACTIVE",
        state: idleMs > 2 * config.inactiveAfterDays * DAY_MS ? "AT_RISK" : "NEEDS_ATTENTION",
        days: wholeDays(lastActivityAt, now),
        at: lastActivityAt.toISOString(),
      });
    }
  } else if (facts.externalCreatedAt && now.getTime() - facts.externalCreatedAt.getTime() > config.inactiveAfterDays * DAY_MS) {
    reasons.push({
      code: "INACTIVE",
      state: "AT_RISK",
      days: wholeDays(facts.externalCreatedAt, now),
      at: facts.externalCreatedAt.toISOString(),
    });
  }

  if (config.flagMissingNextActivity && (!facts.nextActivityAt || facts.nextActivityAt.getTime() < now.getTime())) {
    reasons.push({
      code: "NO_NEXT_ACTIVITY",
      state: "NEEDS_ATTENTION",
      ...(facts.nextActivityAt ? { at: facts.nextActivityAt.toISOString() } : {}),
    });
  }

  if (!facts.trackable) reasons.push({ code: "UNTRACKABLE", state: "NEEDS_ATTENTION" });

  reasons.sort((a, b) => RANK[b.state] - RANK[a.state] || REASON_CODES.indexOf(a.code) - REASON_CODES.indexOf(b.code));
  const state = reasons.reduce<HealthState>((s, r) => (RANK[r.state] > RANK[s] ? r.state : s), "HEALTHY");
  return { state, reasons, lastEmailAt, lastActivityAt };
}

/** Stable identity of an evaluation: state + sorted reason codes. */
export function healthFingerprint(e: Pick<HealthEvaluation, "state" | "reasons">): string {
  return `${e.state}|${[...new Set(e.reasons.map((r) => r.code))].sort().join(",")}`;
}

export function parseFingerprint(fp: string | null): { state: HealthState; codes: Set<string> } | null {
  if (!fp) return null;
  const [state, codes = ""] = fp.split("|");
  if (!state || !(HEALTH_STATES as readonly string[]).includes(state)) return null;
  return { state: state as HealthState, codes: new Set(codes.split(",").filter(Boolean)) };
}

/** True when `next` is worse than `prev`: a higher state or a new reason code. */
export function isEscalation(prev: string | null, next: string): boolean {
  const a = parseFingerprint(prev);
  const b = parseFingerprint(next);
  if (!b) return false;
  if (!a) return true;
  if (RANK[b.state] > RANK[a.state]) return true;
  return [...b.codes].some((c) => !a.codes.has(c));
}

const REASON_TEXT: Record<ReasonCode, (r: HealthReason) => string> = {
  PAST_CLOSE_DATE: (r) => `The close date passed ${r.days ?? 1} day${r.days === 1 ? "" : "s"} ago.`,
  AWAITING_OUR_REPLY: (r) => `The buyer's last email has been unanswered for ${r.days ?? 0} days.`,
  AWAITING_BUYER_REPLY: (r) => `Our last email has been unanswered for ${r.days ?? 0} days.`,
  INACTIVE: (r) => `No email or CRM activity for ${r.days ?? 0} days.`,
  NO_NEXT_ACTIVITY: () => "No next activity is scheduled in HubSpot.",
  UNTRACKABLE: () => "No contact email or company domain to track activity against.",
};

const TITLE: Record<ReasonCode, (deal: string) => string> = {
  PAST_CLOSE_DATE: (d) => `${d} is past its close date`,
  AWAITING_OUR_REPLY: (d) => `${d}: the buyer is waiting for a reply`,
  AWAITING_BUYER_REPLY: (d) => `${d}: waiting for the buyer to reply`,
  INACTIVE: (d) => `${d} has gone quiet`,
  NO_NEXT_ACTIVITY: (d) => `${d} has no next step scheduled`,
  UNTRACKABLE: (d) => `${d} has no contacts to track`,
};

/** Fixed-template recommendation text (no AI). `dealName` is untrusted CRM data, rendered as text. */
export function describeEvaluation(dealName: string, e: HealthEvaluation): { title: string; summary: string } {
  const name = dealName.trim().slice(0, 120) || "Untitled deal";
  const top = e.reasons[0];
  return {
    title: top ? TITLE[top.code](name) : `${name} is healthy`,
    summary: e.reasons.map((r) => REASON_TEXT[r.code](r)).join(" "),
  };
}
