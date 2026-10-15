/**
 * Integration providers supported in the MVP. Adding one means adding an
 * entry here, a Prisma enum value, and an adapter — never a domain-model change.
 */
export const INTEGRATION_PROVIDERS = ["GMAIL", "HUBSPOT", "GOOGLE_CALENDAR"] as const;
export type IntegrationProviderKey = (typeof INTEGRATION_PROVIDERS)[number];

/** What a provider can do. Actions declare which capability they need. */
export type IntegrationCapability =
  | "email.read"
  | "email.draft"
  | "email.send"
  | "crm.read"
  | "crm.write"
  | "calendar.read"
  | "calendar.write";

export interface IntegrationProviderInfo {
  readonly key: IntegrationProviderKey;
  readonly displayName: string;
  readonly capabilities: readonly IntegrationCapability[];
}

export const INTEGRATION_PROVIDER_INFO: Record<IntegrationProviderKey, IntegrationProviderInfo> = {
  GMAIL: { key: "GMAIL", displayName: "Gmail", capabilities: ["email.read", "email.draft", "email.send"] },
  HUBSPOT: { key: "HUBSPOT", displayName: "HubSpot", capabilities: ["crm.read", "crm.write"] },
  GOOGLE_CALENDAR: {
    key: "GOOGLE_CALENDAR",
    displayName: "Google Calendar",
    capabilities: ["calendar.read", "calendar.write"],
  },
};
