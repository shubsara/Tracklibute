import { resetEnvCache } from "@/lib/env";

import { FAKE_HUBSPOT_CLIENT_ID, FAKE_HUBSPOT_CLIENT_SECRET, FakeHubSpot } from "./fake-hubspot";

export const HUBSPOT_REDIRECT = "http://localhost/api/integrations/hubspot/callback";
export const SPEC03_CRON_SECRET = "spec03-cron-secret-for-tests-0123456789";

/** Start the fake HubSpot server and point the app's HubSpot config at it. */
export async function startFakeHubSpotEnv(): Promise<FakeHubSpot> {
  const hubspot = await new FakeHubSpot().start();
  Object.assign(process.env, {
    HUBSPOT_CLIENT_ID: FAKE_HUBSPOT_CLIENT_ID,
    HUBSPOT_CLIENT_SECRET: FAKE_HUBSPOT_CLIENT_SECRET,
    HUBSPOT_REDIRECT_URI: HUBSPOT_REDIRECT,
    HUBSPOT_API_BASE_URL: hubspot.base,
    HUBSPOT_AUTH_BASE_URL: hubspot.base,
    CRON_SECRET: SPEC03_CRON_SECRET,
  });
  resetEnvCache();
  return hubspot;
}
