import "server-only";

import type {
  CrmCompanyRecord,
  CrmContactRecord,
  CrmDealRecord,
  CrmOwnerRecord,
  CrmStageRecord,
} from "@/domain/crm/types";
import { normalizeEmailAddress } from "@/domain/email/participants";
import { normalizeDomain } from "@/domain/email/activity";

import type { HubSpotObject, hubspotOwnersSchema, hubspotPipelinesSchema } from "./hubspot.types";
import type { z } from "zod";

/** Deal properties requested from HubSpot — nothing else is fetched. */
export const DEAL_PROPERTIES = [
  "dealname",
  "amount",
  "deal_currency_code",
  "pipeline",
  "dealstage",
  "hubspot_owner_id",
  "closedate",
  "createdate",
  "hs_lastmodifieddate",
  "notes_last_updated",
  "notes_last_contacted",
  "notes_next_activity_date",
  "hs_is_closed",
  "hs_is_closed_won",
] as const;
export const CONTACT_PROPERTIES = [
  "email",
  "firstname",
  "lastname",
  "lifecyclestage",
  "hs_lead_status",
  "hubspot_owner_id",
  "createdate",
  "lastmodifieddate",
  "notes_last_updated",
  "notes_last_contacted",
  "notes_next_activity_date",
  "hs_v2_date_entered_salesqualifiedlead",
  "hs_v2_date_entered_marketingqualifiedlead",
] as const;
export const COMPANY_PROPERTIES = ["name", "domain", "hs_lastmodifieddate"] as const;

const MAX_TEXT = 200;

function text(v: string | null | undefined, max = MAX_TEXT): string | null {
  const t = v?.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

/** HubSpot dates arrive as ISO strings or epoch-ms strings. */
export function parseHubSpotDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const t = /^\d{10,}$/.test(v.trim()) ? Number(v) : Date.parse(v);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return d.getUTCFullYear() < 1971 || d.getUTCFullYear() > 9999 ? null : d;
}

function bool(v: string | null | undefined): boolean | null {
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

function amount(v: string | null | undefined): string | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) < 1e16 ? n.toFixed(2) : null;
}

const id = (v: string | null | undefined) => (v && /^[A-Za-z0-9_-]{1,64}$/.test(v.trim()) ? v.trim() : null);

export function mapDeal(o: HubSpotObject): CrmDealRecord {
  const p = o.properties;
  const assoc = o.associations;
  return {
    externalId: o.id,
    name: text(p.dealname) ?? "Untitled deal",
    amount: amount(p.amount),
    currency: text(p.deal_currency_code, 8),
    pipelineExternalId: id(p.pipeline),
    stageExternalId: id(p.dealstage),
    ownerExternalId: id(p.hubspot_owner_id),
    isClosed: bool(p.hs_is_closed),
    isWon: bool(p.hs_is_closed_won),
    closeDate: parseHubSpotDate(p.closedate),
    externalCreatedAt: parseHubSpotDate(p.createdate) ?? parseHubSpotDate(o.createdAt),
    externalUpdatedAt: parseHubSpotDate(p.hs_lastmodifieddate) ?? parseHubSpotDate(o.updatedAt),
    crmLastActivityAt: parseHubSpotDate(p.notes_last_updated),
    crmLastContactedAt: parseHubSpotDate(p.notes_last_contacted),
    nextActivityAt: parseHubSpotDate(p.notes_next_activity_date),
    contactIds: assoc ? [...new Set((assoc.contacts?.results ?? []).map((r) => r.id))] : null,
    companyIds: assoc ? [...new Set((assoc.companies?.results ?? []).map((r) => r.id))] : null,
  };
}

export function mapContact(o: HubSpotObject): CrmContactRecord {
  const p = o.properties;
  return {
    externalId: o.id,
    email: p.email ? normalizeEmailAddress(p.email) : null,
    firstName: text(p.firstname, 100),
    lastName: text(p.lastname, 100),
    lifecycleStage: text(p.lifecyclestage, 64)?.toLowerCase() ?? null,
    leadStatus: text(p.hs_lead_status, 64)?.toLowerCase() ?? null,
    ownerExternalId: id(p.hubspot_owner_id),
    externalCreatedAt: parseHubSpotDate(p.createdate) ?? parseHubSpotDate(o.createdAt),
    externalUpdatedAt: parseHubSpotDate(p.lastmodifieddate) ?? parseHubSpotDate(o.updatedAt),
    dateEnteredSalesQualifiedLead: parseHubSpotDate(p.hs_v2_date_entered_salesqualifiedlead),
    dateEnteredMarketingQualifiedLead: parseHubSpotDate(p.hs_v2_date_entered_marketingqualifiedlead),
    crmLastActivityAt: parseHubSpotDate(p.notes_last_updated),
    crmLastContactedAt: parseHubSpotDate(p.notes_last_contacted),
    nextActivityAt: parseHubSpotDate(p.notes_next_activity_date),
  };
}

export function mapCompany(o: HubSpotObject): CrmCompanyRecord {
  const p = o.properties;
  return {
    externalId: o.id,
    name: text(p.name),
    domain: normalizeDomain(p.domain),
    externalUpdatedAt: parseHubSpotDate(p.hs_lastmodifieddate) ?? parseHubSpotDate(o.updatedAt),
  };
}

export function mapOwner(o: z.infer<typeof hubspotOwnersSchema>["results"][number]): CrmOwnerRecord {
  return {
    externalId: o.id,
    email: o.email ? normalizeEmailAddress(o.email) : null,
    firstName: text(o.firstName, 100),
    lastName: text(o.lastName, 100),
    archived: o.archived ?? false,
  };
}

export function mapStages(res: z.infer<typeof hubspotPipelinesSchema>): CrmStageRecord[] {
  return res.results.flatMap((pipeline) =>
    pipeline.stages.map((s) => {
      const meta = s.metadata ?? {};
      // Deal stage metadata carries string flags ("true"/"false"); anything
      // else — including a missing key — leaves closed-ness unknown.
      const closedFlag = typeof meta.isClosed === "boolean" ? String(meta.isClosed) : meta.isClosed;
      const isClosed = closedFlag === "true" ? true : closedFlag === "false" ? false : null;
      const probability = typeof meta.probability === "string" || typeof meta.probability === "number" ? Number(meta.probability) : NaN;
      const hasProbability = Number.isFinite(probability);
      return {
        pipelineExternalId: pipeline.id,
        pipelineLabel: text(pipeline.label) ?? pipeline.id,
        externalId: s.id,
        label: text(s.label) ?? s.id,
        displayOrder: s.displayOrder ?? 0,
        isClosed,
        isWon: isClosed === true && hasProbability ? probability >= 1 : null,
        probability: hasProbability ? Math.min(1, Math.max(0, probability)) : null,
      };
    }),
  );
}
