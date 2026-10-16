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

export const hubspotPipelinesSchema = z.object({
  results: z.array(
    z.object({
      id: str,
      label: str,
      displayOrder: z.number().optional(),
      stages: z.array(
        z.object({
          id: str,
          label: str,
          displayOrder: z.number().optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        }),
      ),
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

export const hubspotTokenSchema = z.object({
  access_token: str.min(1),
  refresh_token: str.min(1).optional(),
  expires_in: z.number().int().positive(),
  token_type: str.optional(),
});

export const hubspotTokenInfoSchema = z.object({
  hub_id: z.union([z.number(), str]).transform(String),
  scopes: z.array(str).default([]),
  hub_domain: nullableStr,
  user: nullableStr,
});

/** Error bodies: only machine-readable reason codes are ever read. */
export interface HubSpotErrorBody {
  status?: unknown;
  category?: unknown;
  subCategory?: unknown;
  policyName?: unknown;
  errorType?: unknown;
}
