import { z } from "zod";

import type { MemberRole } from "@/domain/auth/auth-context";
import type { IntegrationCapability, IntegrationProviderKey } from "@/domain/integrations/providers";

/**
 * The closed Action Registry.
 *
 *   AI / recommendation ─▶ ProposedAction ─▶ ActionRegistry ─▶ policy
 *       ─▶ approval (if consequential) ─▶ executor
 *
 * Every side effect Tracklibute can ever perform is a typed entry here. An
 * LLM can only *propose* one of these types with a payload that must pass the
 * entry's schema; it can never name an endpoint, HTTP method, or code path.
 * Unknown types are rejected. There is no "generic HTTP" or "run script" action.
 *
 * `consequential` = visible to people outside the user, or hard to reverse
 * (sending email, writing to the shared CRM, inviting attendees). Those always
 * require a human approval record — enforced again by the database.
 */
export interface ActionDefinition<S extends z.ZodType = z.ZodType> {
  readonly type: string;
  readonly description: string;
  /** External system touched, or null for internal-only actions. */
  readonly provider: IntegrationProviderKey | null;
  readonly capability: IntegrationCapability | null;
  readonly consequential: boolean;
  /** Minimum role allowed to propose / approve / execute this action. */
  readonly minRole: MemberRole;
  readonly payloadSchema: S;
}

const emailAddress = z.email().max(320);
const nonEmpty = (max: number) => z.string().trim().min(1).max(max);

export const ACTION_REGISTRY = {
  "recommendation.snooze": {
    type: "recommendation.snooze",
    description: "Snooze a recommendation inside Tracklibute until a given time.",
    provider: null,
    capability: null,
    consequential: false,
    minRole: "MEMBER",
    payloadSchema: z
      .object({ recommendationId: z.uuid(), until: z.iso.datetime({ offset: true }) })
      .strict(),
  },
  "gmail.create_draft": {
    type: "gmail.create_draft",
    description: "Create a Gmail draft for the user to review. Nothing is sent.",
    provider: "GMAIL",
    capability: "email.draft",
    consequential: false,
    minRole: "MEMBER",
    payloadSchema: z
      .object({
        to: z.array(emailAddress).min(1).max(20),
        subject: nonEmpty(300),
        bodyText: nonEmpty(20_000),
        threadId: z.string().max(200).optional(),
      })
      .strict(),
  },
  "gmail.send_email": {
    type: "gmail.send_email",
    description: "Send an email from the user's connected Gmail account.",
    provider: "GMAIL",
    capability: "email.send",
    consequential: true,
    minRole: "MEMBER",
    payloadSchema: z
      .object({
        to: z.array(emailAddress).min(1).max(20),
        cc: z.array(emailAddress).max(20).optional(),
        subject: nonEmpty(300),
        bodyText: nonEmpty(20_000),
        threadId: z.string().max(200).optional(),
      })
      .strict(),
  },
  "hubspot.create_task": {
    type: "hubspot.create_task",
    description: "Create a task on a HubSpot record.",
    provider: "HUBSPOT",
    capability: "crm.write",
    consequential: true,
    minRole: "MEMBER",
    payloadSchema: z
      .object({
        objectType: z.enum(["contact", "deal", "company"]),
        objectId: nonEmpty(64),
        title: nonEmpty(255),
        dueAt: z.iso.datetime({ offset: true }),
        notes: z.string().max(5_000).optional(),
      })
      .strict(),
  },
  "hubspot.update_deal_stage": {
    type: "hubspot.update_deal_stage",
    description: "Move a HubSpot deal to a different pipeline stage.",
    provider: "HUBSPOT",
    capability: "crm.write",
    consequential: true,
    minRole: "MEMBER",
    payloadSchema: z.object({ dealId: nonEmpty(64), stageId: nonEmpty(64) }).strict(),
  },
  "google_calendar.create_event": {
    type: "google_calendar.create_event",
    description: "Create a calendar event and invite attendees.",
    provider: "GOOGLE_CALENDAR",
    capability: "calendar.write",
    consequential: true,
    minRole: "MEMBER",
    payloadSchema: z
      .object({
        title: nonEmpty(300),
        startAt: z.iso.datetime({ offset: true }),
        endAt: z.iso.datetime({ offset: true }),
        attendees: z.array(emailAddress).max(50),
        description: z.string().max(5_000).optional(),
      })
      .strict(),
  },
} as const satisfies Record<string, ActionDefinition>;

export type ActionType = keyof typeof ACTION_REGISTRY;
export type ActionPayload<T extends ActionType> = z.infer<(typeof ACTION_REGISTRY)[T]["payloadSchema"]>;

export function isActionType(value: string): value is ActionType {
  return Object.prototype.hasOwnProperty.call(ACTION_REGISTRY, value);
}

export function getActionDefinition(type: string): ActionDefinition | null {
  return isActionType(type) ? ACTION_REGISTRY[type] : null;
}
