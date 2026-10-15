import { resetEnvCache } from "@/lib/env";
import { resetGoogleOidcCache } from "@/server/auth/google-oidc";

import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FakeGoogle } from "./fake-google";

export const LOGIN_REDIRECT = "http://localhost/api/auth/google/callback";
export const GMAIL_REDIRECT = "http://localhost/api/integrations/gmail/callback";
export const CRON_SECRET = "cron-secret-for-tests-0123456789abcdef";

/** Start the fake Google server and point the app's Google config at it. */
export async function startFakeGoogleEnv(): Promise<FakeGoogle> {
  const google = await new FakeGoogle().start();
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: FAKE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: FAKE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI: LOGIN_REDIRECT,
    GMAIL_REDIRECT_URI: GMAIL_REDIRECT,
    GOOGLE_ISSUER: google.issuer,
    GMAIL_API_BASE_URL: google.gmailBase,
    GMAIL_SYNC_CRON_SECRET: CRON_SECRET,
  });
  resetEnvCache();
  resetGoogleOidcCache();
  return google;
}

/** Collect everything written to console during a block (for secret-leak assertions). */
/* eslint-disable no-console -- test helper that intercepts console output */
export function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = { info: console.info, warn: console.warn, error: console.error, log: console.log };
  for (const k of ["info", "warn", "error", "log"] as const) {
    console[k] = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }
  return { lines, restore: () => Object.assign(console, orig) };
}
