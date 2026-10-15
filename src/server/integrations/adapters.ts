import "server-only";

import {
  type IntegrationAdapter,
  IntegrationNotImplementedError,
} from "@/domain/integrations/adapter";
import { INTEGRATION_PROVIDER_INFO, type IntegrationProviderKey } from "@/domain/integrations/providers";

/**
 * Placeholder adapter: declares the provider's capabilities so policy checks
 * work, but refuses every network operation. Replaced per provider by
 * GmailAdapter / HubSpotAdapter / GoogleCalendarAdapter in later specs.
 */
class PlaceholderAdapter implements IntegrationAdapter {
  readonly capabilities;
  readonly requiredScopes: readonly string[] = [];

  constructor(readonly provider: IntegrationProviderKey) {
    this.capabilities = INTEGRATION_PROVIDER_INFO[provider].capabilities;
  }

  async beginAuthorization(): Promise<never> {
    throw new IntegrationNotImplementedError(this.provider, "beginAuthorization");
  }
  async completeAuthorization(): Promise<never> {
    throw new IntegrationNotImplementedError(this.provider, "completeAuthorization");
  }
  async checkConnection(): Promise<never> {
    throw new IntegrationNotImplementedError(this.provider, "checkConnection");
  }
}

const adapters: Record<IntegrationProviderKey, IntegrationAdapter> = {
  GMAIL: new PlaceholderAdapter("GMAIL"),
  HUBSPOT: new PlaceholderAdapter("HUBSPOT"),
  GOOGLE_CALENDAR: new PlaceholderAdapter("GOOGLE_CALENDAR"),
};

export function getIntegrationAdapter(provider: IntegrationProviderKey): IntegrationAdapter {
  return adapters[provider];
}
