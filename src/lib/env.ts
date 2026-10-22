import { z } from "zod";

const optionalNonEmpty = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  CREDENTIALS_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64-encoded"),
  // Keys session-token hashing (HMAC), dev token signing and OAuth state cookies.
  SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
  DEV_AUTH_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // Google (sign-in + Gmail). Optional so the app boots without them; features
  // that need them fail with a clear "not configured" error.
  GOOGLE_CLIENT_ID: optionalNonEmpty,
  GOOGLE_CLIENT_SECRET: optionalNonEmpty,
  GOOGLE_REDIRECT_URI: optionalNonEmpty.pipe(z.url().optional()),
  GMAIL_REDIRECT_URI: optionalNonEmpty.pipe(z.url().optional()),
  GMAIL_SYNC_CRON_SECRET: optionalNonEmpty.pipe(z.string().min(32).optional()),
  GMAIL_SYNC_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  // Client-side pacing of Gmail API quota units per second per mailbox.
  // Google allows 6,000 units/min/user (= 100/s); 80 leaves headroom.
  GMAIL_QUOTA_UNITS_PER_SECOND: z.coerce.number().int().min(1).max(1_000_000).default(80),
  // Wall-clock budget for one sync run; large backfills continue on the next run.
  GMAIL_SYNC_RUN_BUDGET_SECONDS: z.coerce.number().int().min(10).max(3600).default(210),

  // HubSpot (read-only CRM connection; org-wide, connected by an ADMIN).
  HUBSPOT_CLIENT_ID: optionalNonEmpty,
  HUBSPOT_CLIENT_SECRET: optionalNonEmpty,
  HUBSPOT_REDIRECT_URI: optionalNonEmpty.pipe(z.url().optional()),
  // Client-side pacing: HubSpot allows 110 requests / 10 s per installed app; 90 leaves headroom.
  HUBSPOT_REQUESTS_PER_10S: z.coerce.number().int().min(1).max(1000).default(90),
  HUBSPOT_SYNC_RUN_BUDGET_SECONDS: z.coerce.number().int().min(10).max(3600).default(240),

  // Bearer secret for the Spec 03 internal cron endpoints (HubSpot sync, Opportunity Health).
  CRON_SECRET: optionalNonEmpty.pipe(z.string().min(32).optional()),

  // Test-only endpoint overrides (ignored unless NODE_ENV=test).
  GOOGLE_ISSUER: optionalNonEmpty,
  GMAIL_API_BASE_URL: optionalNonEmpty,
  HUBSPOT_API_BASE_URL: optionalNonEmpty,
  HUBSPOT_AUTH_BASE_URL: optionalNonEmpty,
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/** Validated server environment. Throws with the offending keys (never values). */
export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration — ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test hook: forget cached env after mutating process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
