import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { getEnv } from "@/lib/env";
import { ServiceUnavailableError, UnauthenticatedError } from "@/lib/errors";

/**
 * `Authorization: Bearer $CRON_SECRET` for the Spec 03 internal cron
 * endpoints (HubSpot sync, Opportunity Health). Constant-time comparison;
 * lengths are hidden via HMAC.
 */
export function verifyCronBearer(headers: Headers): void {
  const secret = getEnv().CRON_SECRET;
  if (!secret) throw new ServiceUnavailableError("Cron endpoints are not configured (CRON_SECRET)");
  const presented = (headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = createHmac("sha256", "cron").update(presented).digest();
  const b = createHmac("sha256", "cron").update(secret).digest();
  if (!presented || !timingSafeEqual(a, b)) throw new UnauthenticatedError("Invalid cron credentials");
}
