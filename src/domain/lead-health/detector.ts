/**
 * Lead Health — deterministic detector.
 * A qualified CRM contact is eligible only when its lifecycle stage is
 * explicitly configured as qualified. Missing qualification dates are never
 * guessed. Email direction/timestamps are metadata-only; message content is
 * not read. Business-day timers ignore Saturdays and Sundays (UTC calendar).
 */

export const LEAD_HEALTH_STATES = ["HEALTHY", "NEEDS_ATTENTION", "AT_RISK"] as const;
export type LeadHealthState = (typeof LEAD_HEALTH_STATES)[number];

export const LEAD_HEALTH_REASON_CODES = [
  "NO_FIRST_TOUCH",
  "AWAITING_OUR_REPLY",
  "AWAITING_BUYER_REPLY",
  "INACTIVE",
] as const;
export type LeadHealthReasonCode = (typeof LEAD_HEALTH_REASON_CODES)[number];

export interface LeadHealthConfig {
  firstTouchWithinBusinessDays: number;
  staleAfterDays: number;
  escalateAfterDays: number;
  firstTouchEscalateAfterBusinessDays: number;
  awaitingReplyAfterBusinessDays: number;
  awaitingReplyEscalateAfterDays: number;
  includeMarketingQualifiedLeads: boolean;
  /** Legacy Spec 04 config; retained so previously stored configs still parse. */
  firstTouchWithinHours?: number;
}

export interface LeadFacts {
  qualificationAt: Date | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  crmLastActivityAt: Date | null;
  crmLastContactedAt: Date | null;
  nextActivityAt: Date | null;
}

export interface LeadHealthReason {
  code: LeadHealthReasonCode;
  state: Exclude<LeadHealthState, "HEALTHY">;
  /** Business days for inactivity/first-touch; elapsed business days for replies. */
  days?: number;
  at?: string;
}

export interface LeadHealthEvaluation {
  state: LeadHealthState;
  reasons: LeadHealthReason[];
  lastActivityAt: Date | null;
  hasFutureNextActivity: boolean;
}

const DAY_MS = 86_400_000;
const RANK: Record<LeadHealthState, number> = { HEALTHY: 0, NEEDS_ATTENTION: 1, AT_RISK: 2 };
const latest = (...dates: (Date | null)[]): Date | null =>
  dates.reduce<Date | null>((a, b) => (b && (!a || b > a) ? b : a), null);

export function calendarDaysSince(from: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / DAY_MS));
}

/** Count weekdays after the start calendar date through the current calendar date. */
export function businessDaysBetween(from: Date, now: Date): number {
  const fromDay = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const nowDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (nowDay <= fromDay) return 0;
  let count = 0;
  for (let day = fromDay + DAY_MS; day <= nowDay; day += DAY_MS) {
    const weekday = new Date(day).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count++;
  }
  return count;
}

export function evaluateLead(facts: LeadFacts, config: LeadHealthConfig, now: Date): LeadHealthEvaluation {
  const reasons: LeadHealthReason[] = [];
  const lastActivityAt = latest(
    facts.lastInboundAt,
    facts.lastOutboundAt,
    facts.crmLastActivityAt,
    facts.crmLastContactedAt,
  );
  const hasFutureNextActivity = Boolean(facts.nextActivityAt && facts.nextActivityAt.getTime() > now.getTime());

  const inboundIsLast = Boolean(
    facts.lastInboundAt && (!facts.lastOutboundAt || facts.lastInboundAt.getTime() > facts.lastOutboundAt.getTime()),
  );
  const outboundIsLast = Boolean(
    facts.lastOutboundAt && (!facts.lastInboundAt || facts.lastOutboundAt.getTime() > facts.lastInboundAt.getTime()),
  );
  let replyReasonDetected = false;

  // A scheduled task does not erase an unanswered email. Direction and timestamps
  // are used only; the detector never inspects message subjects or bodies.
  if (inboundIsLast && facts.lastInboundAt) {
    const businessDays = businessDaysBetween(facts.lastInboundAt, now);
    const calendarDays = calendarDaysSince(facts.lastInboundAt, now);
    if (businessDays > config.awaitingReplyAfterBusinessDays) {
      reasons.push({
        code: "AWAITING_OUR_REPLY",
        state: calendarDays > config.awaitingReplyEscalateAfterDays ? "AT_RISK" : "NEEDS_ATTENTION",
        days: businessDays,
        at: facts.lastInboundAt.toISOString(),
      });
      replyReasonDetected = true;
    }
  } else if (outboundIsLast && facts.lastOutboundAt) {
    const businessDays = businessDaysBetween(facts.lastOutboundAt, now);
    const calendarDays = calendarDaysSince(facts.lastOutboundAt, now);
    if (businessDays > config.awaitingReplyAfterBusinessDays) {
      reasons.push({
        code: "AWAITING_BUYER_REPLY",
        state: calendarDays > config.awaitingReplyEscalateAfterDays ? "AT_RISK" : "NEEDS_ATTENTION",
        days: businessDays,
        at: facts.lastOutboundAt.toISOString(),
      });
      replyReasonDetected = true;
    }
  }

  // A future planned action protects general first-touch/inactivity checks,
  // but intentionally does not suppress a direction-specific overdue reply.
  if (!hasFutureNextActivity && !replyReasonDetected) {
    const contactedAt = latest(facts.lastOutboundAt, facts.lastInboundAt, facts.crmLastContactedAt);
    const touchedAfterQualification = Boolean(
      facts.qualificationAt && contactedAt && contactedAt.getTime() >= facts.qualificationAt.getTime(),
    );

    if (facts.qualificationAt && !touchedAfterQualification) {
      const days = businessDaysBetween(facts.qualificationAt, now);
      if (days > config.firstTouchWithinBusinessDays) {
        reasons.push({
          code: "NO_FIRST_TOUCH",
          state: days > config.firstTouchEscalateAfterBusinessDays ? "AT_RISK" : "NEEDS_ATTENTION",
          days,
          at: facts.qualificationAt.toISOString(),
        });
      }
    } else if (lastActivityAt) {
      const days = businessDaysBetween(lastActivityAt, now);
      if (days > config.staleAfterDays) {
        reasons.push({
          code: "INACTIVE",
          state: days > config.escalateAfterDays ? "AT_RISK" : "NEEDS_ATTENTION",
          days,
          at: lastActivityAt.toISOString(),
        });
      }
    }
  }

  reasons.sort((a, b) => RANK[b.state] - RANK[a.state] || LEAD_HEALTH_REASON_CODES.indexOf(a.code) - LEAD_HEALTH_REASON_CODES.indexOf(b.code));
  const state = reasons.reduce<LeadHealthState>((current, reason) => RANK[reason.state] > RANK[current] ? reason.state : current, "HEALTHY");
  return { state, reasons, lastActivityAt, hasFutureNextActivity };
}

export function leadHealthFingerprint(evaluation: Pick<LeadHealthEvaluation, "state" | "reasons">): string {
  return `${evaluation.state}|${[...new Set(evaluation.reasons.map((r) => r.code))].sort().join(",")}`;
}

export function parseLeadHealthFingerprint(value: string | null): { state: LeadHealthState; codes: Set<string> } | null {
  if (!value) return null;
  const [state, codes = ""] = value.split("|");
  if (!state || !(LEAD_HEALTH_STATES as readonly string[]).includes(state)) return null;
  return { state: state as LeadHealthState, codes: new Set(codes.split(",").filter(Boolean)) };
}

export function isLeadHealthEscalation(previous: string | null, next: string): boolean {
  const a = parseLeadHealthFingerprint(previous);
  const b = parseLeadHealthFingerprint(next);
  if (!b) return false;
  if (!a) return true;
  if (RANK[b.state] > RANK[a.state]) return true;
  return [...b.codes].some((code) => !a.codes.has(code));
}

const REASON_TEXT: Record<LeadHealthReasonCode, (reason: LeadHealthReason) => string> = {
  NO_FIRST_TOUCH: (r) => `No first sales touch was detected ${r.days ?? 0} business days after qualification.`,
  AWAITING_OUR_REPLY: (r) => `The prospect's last email has been unanswered for ${r.days ?? 0} business days.`,
  AWAITING_BUYER_REPLY: (r) => `Our last matched email has been unanswered for ${r.days ?? 0} business days.`,
  INACTIVE: (r) => `No meaningful email or CRM contact activity was detected for ${r.days ?? 0} business days.`,
};

const TITLE: Record<LeadHealthReasonCode, (name: string) => string> = {
  NO_FIRST_TOUCH: (name) => `${name} has not received a first sales touch`,
  AWAITING_OUR_REPLY: (name) => `${name} is waiting for a sales reply`,
  AWAITING_BUYER_REPLY: (name) => `${name} has not replied`,
  INACTIVE: (name) => `${name} may be going cold`,
};

export function describeLeadEvaluation(nameInput: string, evaluation: LeadHealthEvaluation): { title: string; summary: string } {
  const name = nameInput.trim().slice(0, 120) || "Untitled lead";
  const first = evaluation.reasons[0];
  return {
    title: first ? TITLE[first.code](name) : `${name} is healthy`,
    summary: evaluation.reasons.map((reason) => REASON_TEXT[reason.code](reason)).join(" "),
  };
}
