import { z } from "zod";

import { LEAD_HEALTH_REASON_CODES, LEAD_HEALTH_STATES } from "./detector";

const iso = z.iso.datetime({ offset: true });
const normalizedProperty = z.string().regex(/^[a-z0-9_]{1,64}$/).nullable();

export const leadHealthEvidenceSchema = z.object({
  state: z.enum(LEAD_HEALTH_STATES),
  reasons: z.array(z.object({
    code: z.enum(LEAD_HEALTH_REASON_CODES),
    state: z.enum(["NEEDS_ATTENTION", "AT_RISK"]),
    days: z.number().int().min(0).max(100_000).optional(),
    at: iso.optional(),
  }).strict()).max(LEAD_HEALTH_REASON_CODES.length),
  qualificationAt: iso.nullable(),
  lastInboundAt: iso.nullable(),
  lastOutboundAt: iso.nullable(),
  lastActivityAt: iso.nullable(),
  crmLastActivityAt: iso.nullable(),
  crmLastContactedAt: iso.nullable(),
  nextActivityAt: iso.nullable(),
  lastAccountActivityAt: iso.nullable(),
  accountMoreRecentlyActive: z.boolean(),
  lifecycleStage: normalizedProperty,
  leadStatus: normalizedProperty,
  connectedMailboxes: z.number().int().min(0),
  ownerMapped: z.boolean(),
  ownerMailboxConnected: z.boolean(),
  limitedSignal: z.boolean(),
  priorClosedLost: z.boolean(),
  contact: z.object({ id: z.uuid(), externalId: z.string().max(64) }).strict(),
}).strict();

export type LeadHealthEvidence = z.infer<typeof leadHealthEvidenceSchema>;

export function assertLeadHealthEvidence(value: unknown): LeadHealthEvidence {
  return leadHealthEvidenceSchema.parse(value);
}
