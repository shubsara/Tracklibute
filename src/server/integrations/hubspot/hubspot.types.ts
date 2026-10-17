import { z } from "zod";

/**
 * Zod shapes for the HubSpot responses Tracklibute reads. Unknown fields are
 * ignored; anything we rely on is validated before it reaches the mapper.
 */
const str = z.string();
const nullableStr = z.string().nullable().optional();
const props = z.record(z.string(), z.string().nullable().optional());

const paging = z
  .object({ next: z.object({ after: z.union([z.string(), z.number()]).transform(String) }).optional() })
  .optional();

const assocList = z.object({ results: z.array(z.object({ id: z.union([str, z.number()]).transform(String) })) }).optional();

export const hubspotObjectSchema = z.object({
  id: z.union([str, z.number()]).transform(String),
  properties: props.default({}),
  createdAt: nullableStr,
  updatedAt: nullableStr,
  archived: z.boolean().optional(),
  associations: z.object({ contacts: assocList, companies: assocList }).partial().optional(),
});
export type HubSpotObject = z.infer<typeof hubspotObjectSchema>;

export const hubspotListSchema = z.object({ results: z.array(hubspotObjectSchema), paging });
export const hubspotSearchSchema = z.object({ total: z.number().optional(), results: z.array(hubspotObjectSchema), paging });
export const hubspotBatchReadSchema = z.object({ results: z.array(hubspotObjectSchema) });

export const hubspotOwnersSchema = z.object({
  results: z.array(
    z.object({
      id: z.union([str, z.number()]).transform(String),
      email: nullableStr,
      firstName: nullableStr,
      lastName: nullableStr,
      archived: z.boolean().optional(),
    }),
  ),
  paging,
});

/**
 * GET /crm/pipelines/2026-09/deals. Documented fields per pipeline and stage:
 * id, label, displayOrder, archived, archivedAt, createdAt, updatedAt; stages
 * also carry `metadata` (an untyped object — for deals HubSpot puts string
 * values such as isClosed / probability there) and `writePermissions`.
 * Unknown fields are ignored; required identifiers must be present.
 */
const pipelineStageSchema = z.object({
  id: str.min(1),
  label: str,
  displayOrder: z.number().optional(),
  archived: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});
export const hubspotPipelinesSchema = z.object({
  results: z.array(
    z.object({
      id: str.min(1),
      label: str,
      displayOrder: z.number().optional(),
      archived: z.boolean().optional(),
      stages: z.array(pipelineStageSchema),
    }),
  ),
});

export const hubspotAssociationsSchema = z.object({
  results: z.array(
    z.object({
      from: z.object({ id: z.union([str, z.number()]).transform(String) }),
      to: z.array(z.object({ toObjectId: z.union([str, z.number()]).transform(String) })),
    }),
  ),
});

/** POST /oauth/2026-03/token (authorization_code | refresh_token). */
export const hubspotTokenSchema = z.object({
  access_token: str.min(1),
  refresh_token: str.min(1).optional(),
  expires_in: z.number().int().positive(),
  token_type: str.optional(),
  // Present in current responses; cross-checked against introspection when given.
  hub_id: z.union([z.number(), str]).transform(String).optional(),
  scopes: z.array(str).optional(),
});

/**
 * POST /oauth/2026-03/token/introspect (token_type_hint=access_token).
 * Only the fields Tracklibute relies on are modelled; the echoed `token` and
 * the `signed_access_token` signatures are deliberately never read or kept.
 */
export const hubspotIntrospectionSchema = z.object({
  active: z.boolean(),
  token_use: str.optional(),
  client_id: str.optional(),
  hub_id: z.union([z.number(), str]).transform(String).optional(),
  scopes: z.array(str).optional(),
  expires_in: z.number().optional(),
  signed_access_token: z.object({ isUserLevel: z.boolean().optional() }).partial().nullable().optional(),
});
export type HubSpotIntrospection = z.infer<typeof hubspotIntrospectionSchema>;

/** Error bodies: only machine-readable reason codes are ever read. */
export interface HubSpotErrorBody {
  /** RFC 6749 OAuth error code (invalid_grant, invalid_client, ...). */
  error?: unknown;
  status?: unknown;
  category?: unknown;
  subCategory?: unknown;
  policyName?: unknown;
  errorType?: unknown;
}
