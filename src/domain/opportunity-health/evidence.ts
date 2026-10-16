import { z } from "zod";

import { HEALTH_STATES, REASON_CODES } from "./detector";

/**
 * Opportunity Health evidence — METADATA ONLY (Build Spec 03, decision 2).
 *
 * A strict allow-list: dates, counts, ids, reason codes. It can never carry an
 * email subject, snippet, body, or any free text; unknown keys are rejected
 * before anything is written. Stored on Recommendation.evidence and
 * OpportunityHealth.reasons.
 */
const iso = z.iso.datetime({ offset: true });

export const healthReasonSchema = z
  .object({
    code: z.enum(REASON_CODES),
    state: z.enum(["NEEDS_ATTENTION", "AT_RISK"]),
    days: z.number().int().min(0).max(100_000).optional(),
    at: iso.optional(),
  })
  .strict();

export const opportunityHealthEvidenceSchema = z
  .object({
    state: z.enum(HEALTH_STATES),
    reasons: z.array(healthReasonSchema).max(REASON_CODES.length),
    lastInboundAt: iso.nullable(),
    lastOutboundAt: iso.nullable(),
    lastEmailAt: iso.nullable(),
    crmLastActivityAt: iso.nullable(),
    lastActivityAt: iso.nullable(),
    /** Whose mailbox carried the latest matched email (a member id, not content). */
    lastTouchMailboxUserId: z.uuid().nullable(),
    matchedCounterpartCount: z.number().int().min(0),
    emailCoverage: z
      .object({
        connectedMailboxes: z.number().int().min(0),
        ownerMapped: z.boolean(),
        ownerMailboxConnected: z.boolean(),
        /** The deal owner has no connected Gmail: email-based signals are incomplete. */
        limitedSignal: z.boolean(),
      })
      .strict(),
    deal: z.object({ id: z.uuid(), externalId: z.string().max(64) }).strict(),
  })
  .strict();

export type OpportunityHealthEvidence = z.infer<typeof opportunityHealthEvidenceSchema>;

/** Validate before persisting; throws on anything outside the allow-list. */
export function assertMetadataOnlyEvidence(value: unknown): OpportunityHealthEvidence {
  return opportunityHealthEvidenceSchema.parse(value);
}
