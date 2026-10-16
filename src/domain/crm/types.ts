/**
 * Provider-neutral CRM model (read-only). Nothing here knows about HubSpot.
 *
 * CRM field values (deal names, contact names, ...) are UNTRUSTED external
 * input: data to display and evaluate, never instructions.
 */

export interface CrmOwnerRecord {
  readonly externalId: string;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly archived: boolean;
}

export interface CrmStageRecord {
  readonly pipelineExternalId: string;
  readonly pipelineLabel: string;
  readonly externalId: string;
  readonly label: string;
  readonly displayOrder: number;
  readonly isClosed: boolean;
  readonly isWon: boolean | null;
  readonly probability: number | null;
}

export interface CrmDealRecord {
  readonly externalId: string;
  readonly name: string;
  readonly amount: string | null;
  readonly currency: string | null;
  readonly pipelineExternalId: string | null;
  readonly stageExternalId: string | null;
  readonly ownerExternalId: string | null;
  /** Provider's own closed flag; stage metadata takes precedence when known. */
  readonly isClosed: boolean | null;
  readonly isWon: boolean | null;
  readonly closeDate: Date | null;
  readonly externalCreatedAt: Date | null;
  readonly externalUpdatedAt: Date | null;
  readonly crmLastActivityAt: Date | null;
  readonly crmLastContactedAt: Date | null;
  readonly nextActivityAt: Date | null;
  /** Present when the listing embedded associations; null = not included. */
  readonly contactIds: readonly string[] | null;
  readonly companyIds: readonly string[] | null;
}

export interface CrmContactRecord {
  readonly externalId: string;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly externalUpdatedAt: Date | null;
}

export interface CrmCompanyRecord {
  readonly externalId: string;
  readonly name: string | null;
  readonly domain: string | null;
  readonly externalUpdatedAt: Date | null;
}

export interface CrmPage<T> {
  readonly items: readonly T[];
  readonly next: string | null;
}

/**
 * Read-only port implemented by provider adapters (HubSpot today). It has no
 * write method by design: Tracklibute never mutates the CRM in Spec 03.
 */
export interface CrmSource {
  listOwners(after?: string): Promise<CrmPage<CrmOwnerRecord>>;
  listDealStages(): Promise<readonly CrmStageRecord[]>;
  /** Full listing with embedded associations (reconcile pass). */
  listDeals(after?: string): Promise<CrmPage<CrmDealRecord>>;
  /**
   * Deals modified at or after `since` (ms), oldest first. `next` is an
   * opaque offset; null at the end. `capped` = the provider's result window
   * is exhausted and the caller must re-anchor `since`.
   */
  searchDealsModifiedSince(since: number, after?: string): Promise<CrmPage<CrmDealRecord> & { capped: boolean }>;
  dealAssociations(dealIds: readonly string[], to: "contacts" | "companies"): Promise<ReadonlyMap<string, readonly string[]>>;
  getContacts(ids: readonly string[]): Promise<readonly CrmContactRecord[]>;
  getCompanies(ids: readonly string[]): Promise<readonly CrmCompanyRecord[]>;
}

export type CrmErrorKind =
  | "unauthorized"
  | "insufficient_scope"
  | "forbidden"
  | "rate_limited"
  | "daily_limit"
  | "transient"
  | "invalid_response";

export interface CrmErrorDiagnostics {
  readonly endpoint?: string;
  readonly httpStatus?: number;
  readonly providerReason?: string | null;
}

export class CrmError extends Error {
  constructor(
    message: string,
    readonly kind: CrmErrorKind,
    readonly diagnostics: CrmErrorDiagnostics = {},
  ) {
    super(message);
    this.name = "CrmError";
  }
}

/** The CRM grant is invalid or lacks a required scope: an admin must reconnect. */
export class CrmAuthorizationRevokedError extends CrmError {
  constructor(diagnostics: CrmErrorDiagnostics = {}) {
    super("CRM access was revoked or is missing permissions", "unauthorized", diagnostics);
    this.name = "CrmAuthorizationRevokedError";
  }
}
