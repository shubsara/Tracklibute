import { z } from "zod";

import type { IntegrationProviderKey } from "@/domain/integrations/providers";

/**
 * Responsibilities are Tracklibute's core abstraction: an ongoing duty the
 * product owns on behalf of the team ("make sure no qualified lead goes
 * cold"), not a user-assembled chain of triggers, conditions and actions.
 *
 * A responsibility is either:
 *  - SYSTEM: instantiated from a template defined here. Its behaviour is
 *    product code; the organization only tunes typed parameters.
 *  - CUSTOM: a named, described responsibility with a narrow, typed config.
 *
 * Config objects are flat, typed parameters — deliberately NOT rules,
 * conditions, or step lists. There is no workflow builder.
 *
 * Foundation defines templates only. Detection logic for each arrives in its
 * own spec after Gmail / HubSpot / Calendar data exists.
 */
export const SYSTEM_TEMPLATE_KEYS = [
  "lead_health",
  "opportunity_health",
  "follow_up",
  "crm_hygiene",
  "meeting_readiness",
] as const;
export type SystemTemplateKey = (typeof SYSTEM_TEMPLATE_KEYS)[number];

export interface SystemResponsibilityTemplate<S extends z.ZodType = z.ZodType> {
  readonly key: SystemTemplateKey;
  readonly name: string;
  readonly description: string;
  /** Data sources the detector will need once implemented. */
  readonly requiredProviders: readonly IntegrationProviderKey[];
  readonly configSchema: S;
}

const days = (def: number) => z.number().int().min(1).max(90).default(def);
const hours = (def: number) => z.number().int().min(1).max(24 * 14).default(def);

export const SYSTEM_RESPONSIBILITY_TEMPLATES = {
  lead_health: {
    key: "lead_health",
    name: "Lead Health",
    description: "Make sure qualified leads receive timely first contact and don't stall before conversion.",
    requiredProviders: ["HUBSPOT", "GMAIL"],
    configSchema: z
      .object({
        firstTouchWithinHours: hours(24),
        staleAfterDays: days(3),
      })
      .strict(),
  },
  opportunity_health: {
    key: "opportunity_health",
    name: "Opportunity Health",
    description: "Detect active opportunities that are going quiet, slipping, or missing a next step.",
    requiredProviders: ["HUBSPOT", "GMAIL", "GOOGLE_CALENDAR"],
    configSchema: z
      .object({
        inactiveAfterDays: days(7),
        flagPastCloseDate: z.boolean().default(true),
      })
      .strict(),
  },
  follow_up: {
    key: "follow_up",
    name: "Follow-up",
    description: "Ensure prospects who are waiting on us get a reply, and promised follow-ups happen.",
    requiredProviders: ["GMAIL", "HUBSPOT"],
    configSchema: z
      .object({
        replyWithinHours: hours(48),
        followUpAfterMeetingHours: hours(24),
      })
      .strict(),
  },
  crm_hygiene: {
    key: "crm_hygiene",
    name: "CRM Hygiene",
    description: "Keep deals and contacts accurate: owners, stages, next steps, and close dates.",
    requiredProviders: ["HUBSPOT"],
    configSchema: z
      .object({
        requireNextStep: z.boolean().default(true),
        requireCloseDate: z.boolean().default(true),
        requireOwner: z.boolean().default(true),
      })
      .strict(),
  },
  meeting_readiness: {
    key: "meeting_readiness",
    name: "Meeting Readiness",
    description: "Make sure reps walk into sales meetings with the context they need.",
    requiredProviders: ["GOOGLE_CALENDAR", "HUBSPOT", "GMAIL"],
    configSchema: z
      .object({
        prepareHoursBefore: hours(24),
      })
      .strict(),
  },
} as const satisfies Record<SystemTemplateKey, SystemResponsibilityTemplate>;

/** CUSTOM responsibilities: a narrow typed config. No conditions, triggers, or steps. */
export const customResponsibilityConfigSchema = z
  .object({
    focus: z.string().trim().max(500).optional(),
    reviewEveryDays: z.number().int().min(1).max(90).optional(),
  })
  .strict();

export function isSystemTemplateKey(value: string): value is SystemTemplateKey {
  return (SYSTEM_TEMPLATE_KEYS as readonly string[]).includes(value);
}

export function defaultConfigFor(key: SystemTemplateKey): Record<string, unknown> {
  return SYSTEM_RESPONSIBILITY_TEMPLATES[key].configSchema.parse({}) as Record<string, unknown>;
}

export function parseSystemConfig(key: SystemTemplateKey, config: unknown): Record<string, unknown> {
  return SYSTEM_RESPONSIBILITY_TEMPLATES[key].configSchema.parse(config) as Record<string, unknown>;
}
