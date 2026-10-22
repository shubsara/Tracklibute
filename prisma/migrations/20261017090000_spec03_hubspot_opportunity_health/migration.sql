-- CreateEnum
CREATE TYPE "crm_owner_mapping_source" AS ENUM ('AUTO_EMAIL', 'MANUAL');

-- CreateEnum
CREATE TYPE "opportunity_health_state" AS ENUM ('HEALTHY', 'NEEDS_ATTENTION', 'AT_RISK');

-- AlterTable
ALTER TABLE "integrations" ADD COLUMN     "email_activity_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "full_synced_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "email_activity_rules_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "internal_email_domains" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "recommendations" ADD COLUMN     "deal_id" UUID,
ADD COLUMN     "dedupe_key" TEXT,
ADD COLUMN     "fingerprint" TEXT,
ADD COLUMN     "last_detected_at" TIMESTAMPTZ(3),
ADD COLUMN     "resolved_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "email_activities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "mailbox_user_id" UUID NOT NULL,
    "external_message_id" TEXT NOT NULL,
    "external_thread_id" TEXT NOT NULL,
    "direction" "email_direction" NOT NULL,
    "counterpart_email" TEXT NOT NULL,
    "counterpart_domain" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_activities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_owners" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "email" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "crm_owners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_owner_mappings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "crm_owner_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "source" "crm_owner_mapping_source" NOT NULL,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "crm_owner_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_pipeline_stages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "pipeline_external_id" TEXT NOT NULL,
    "pipeline_label" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "is_closed" BOOLEAN NOT NULL DEFAULT false,
    "is_won" BOOLEAN,
    "probability" DECIMAL(5,4),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "crm_pipeline_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_companies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT,
    "domain" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "external_updated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "crm_companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "email" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "external_updated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "crm_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_deals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" DECIMAL(18,2),
    "currency" TEXT,
    "pipeline_external_id" TEXT,
    "stage_external_id" TEXT,
    "owner_external_id" TEXT,
    "is_closed" BOOLEAN NOT NULL DEFAULT false,
    "is_won" BOOLEAN,
    "close_date" TIMESTAMPTZ(3),
    "external_created_at" TIMESTAMPTZ(3),
    "external_updated_at" TIMESTAMPTZ(3),
    "crm_last_activity_at" TIMESTAMPTZ(3),
    "crm_last_contacted_at" TIMESTAMPTZ(3),
    "next_activity_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),
    "last_seen_full_sync_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "crm_deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_deal_contacts" (
    "organization_id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,

    CONSTRAINT "crm_deal_contacts_pkey" PRIMARY KEY ("deal_id","contact_id")
);

-- CreateTable
CREATE TABLE "crm_deal_companies" (
    "organization_id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,

    CONSTRAINT "crm_deal_companies_pkey" PRIMARY KEY ("deal_id","company_id")
);

-- CreateTable
CREATE TABLE "opportunity_health" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "deal_id" UUID NOT NULL,
    "responsibility_run_id" UUID,
    "state" "opportunity_health_state" NOT NULL,
    "reasons" JSONB NOT NULL,
    "evaluated_at" TIMESTAMPTZ(3) NOT NULL,
    "state_changed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "opportunity_health_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_activities_organization_id_counterpart_email_occurred_idx" ON "email_activities"("organization_id", "counterpart_email", "occurred_at");

-- CreateIndex
CREATE INDEX "email_activities_organization_id_counterpart_domain_occurre_idx" ON "email_activities"("organization_id", "counterpart_domain", "occurred_at");

-- CreateIndex
CREATE INDEX "email_activities_integration_id_external_message_id_idx" ON "email_activities"("integration_id", "external_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_activities_organization_id_mailbox_user_id_external_m_key" ON "email_activities"("organization_id", "mailbox_user_id", "external_message_id", "counterpart_email");

-- CreateIndex
CREATE UNIQUE INDEX "crm_owners_organization_id_id_key" ON "crm_owners"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_owners_organization_id_integration_id_external_id_key" ON "crm_owners"("organization_id", "integration_id", "external_id");

-- CreateIndex
CREATE INDEX "crm_owner_mappings_organization_id_user_id_idx" ON "crm_owner_mappings"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_owner_mappings_organization_id_crm_owner_id_key" ON "crm_owner_mappings"("organization_id", "crm_owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_pipeline_stages_organization_id_integration_id_pipeline_key" ON "crm_pipeline_stages"("organization_id", "integration_id", "pipeline_external_id", "external_id");

-- CreateIndex
CREATE INDEX "crm_companies_organization_id_domain_idx" ON "crm_companies"("organization_id", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "crm_companies_organization_id_id_key" ON "crm_companies"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_companies_organization_id_integration_id_external_id_key" ON "crm_companies"("organization_id", "integration_id", "external_id");

-- CreateIndex
CREATE INDEX "crm_contacts_organization_id_email_idx" ON "crm_contacts"("organization_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "crm_contacts_organization_id_id_key" ON "crm_contacts"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_contacts_organization_id_integration_id_external_id_key" ON "crm_contacts"("organization_id", "integration_id", "external_id");

-- CreateIndex
CREATE INDEX "crm_deals_organization_id_is_closed_archived_at_idx" ON "crm_deals"("organization_id", "is_closed", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_deals_organization_id_id_key" ON "crm_deals"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_deals_organization_id_integration_id_external_id_key" ON "crm_deals"("organization_id", "integration_id", "external_id");

-- CreateIndex
CREATE INDEX "crm_deal_contacts_organization_id_contact_id_idx" ON "crm_deal_contacts"("organization_id", "contact_id");

-- CreateIndex
CREATE INDEX "crm_deal_companies_organization_id_company_id_idx" ON "crm_deal_companies"("organization_id", "company_id");

-- CreateIndex
CREATE INDEX "opportunity_health_organization_id_state_idx" ON "opportunity_health"("organization_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "opportunity_health_organization_id_deal_id_key" ON "opportunity_health"("organization_id", "deal_id");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_organization_id_id_key" ON "integrations"("organization_id", "id");

-- CreateIndex
CREATE INDEX "recommendations_organization_id_deal_id_idx" ON "recommendations"("organization_id", "deal_id");

-- CreateIndex
CREATE UNIQUE INDEX "recommendations_organization_id_responsibility_id_dedupe_ke_key" ON "recommendations"("organization_id", "responsibility_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_deal_fkey" FOREIGN KEY ("organization_id", "deal_id") REFERENCES "crm_deals"("organization_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_activities" ADD CONSTRAINT "email_activities_integration_owner_fkey" FOREIGN KEY ("organization_id", "integration_id", "mailbox_user_id") REFERENCES "integrations"("organization_id", "id", "owner_user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_owners" ADD CONSTRAINT "crm_owners_integration_fkey" FOREIGN KEY ("organization_id", "integration_id") REFERENCES "integrations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_owner_mappings" ADD CONSTRAINT "crm_owner_mappings_owner_fkey" FOREIGN KEY ("organization_id", "crm_owner_id") REFERENCES "crm_owners"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_owner_mappings" ADD CONSTRAINT "crm_owner_mappings_member_fkey" FOREIGN KEY ("organization_id", "user_id") REFERENCES "organization_members"("organization_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_pipeline_stages" ADD CONSTRAINT "crm_pipeline_stages_integration_fkey" FOREIGN KEY ("organization_id", "integration_id") REFERENCES "integrations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_companies" ADD CONSTRAINT "crm_companies_integration_fkey" FOREIGN KEY ("organization_id", "integration_id") REFERENCES "integrations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_integration_fkey" FOREIGN KEY ("organization_id", "integration_id") REFERENCES "integrations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_deals" ADD CONSTRAINT "crm_deals_integration_fkey" FOREIGN KEY ("organization_id", "integration_id") REFERENCES "integrations"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_deal_contacts" ADD CONSTRAINT "crm_deal_contacts_deal_fkey" FOREIGN KEY ("organization_id", "deal_id") REFERENCES "crm_deals"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_deal_contacts" ADD CONSTRAINT "crm_deal_contacts_contact_fkey" FOREIGN KEY ("organization_id", "contact_id") REFERENCES "crm_contacts"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_deal_companies" ADD CONSTRAINT "crm_deal_companies_deal_fkey" FOREIGN KEY ("organization_id", "deal_id") REFERENCES "crm_deals"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_deal_companies" ADD CONSTRAINT "crm_deal_companies_company_fkey" FOREIGN KEY ("organization_id", "company_id") REFERENCES "crm_companies"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_health" ADD CONSTRAINT "opportunity_health_deal_fkey" FOREIGN KEY ("organization_id", "deal_id") REFERENCES "crm_deals"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ═══════════════════════════════════════════════════════════════════════════
-- Hand-written guards (Build Spec 03). Same model as earlier migrations: the
-- runtime role is subject to RLS; SECURITY DEFINER functions are the only
-- sanctioned bypasses and each returns the minimum it must.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Org-wide integrations: at most one row per (organization, provider) ───
-- NULL owner_user_id values are distinct in the composite unique above, so
-- enforce org-wide uniqueness with a partial index. Collapse any duplicate
-- placeholder rows first (credential-less PENDING rows only; never real ones).
DELETE FROM integrations i
 USING integrations keep
 WHERE i.owner_user_id IS NULL AND keep.owner_user_id IS NULL
   AND i.organization_id = keep.organization_id
   AND i.provider = keep.provider
   AND i.encrypted_credentials IS NULL
   AND i.status = 'PENDING'
   AND (keep.created_at, keep.id) < (i.created_at, i.id);
CREATE UNIQUE INDEX integrations_org_provider_orgwide_uq
  ON integrations (organization_id, provider) WHERE owner_user_id IS NULL;

-- ─── Responsibility runs: at most one active run per responsibility ────────
CREATE UNIQUE INDEX responsibility_runs_one_active
  ON responsibility_runs (organization_id, responsibility_id) WHERE status IN ('QUEUED', 'RUNNING');

-- ─── EmailActivity: content-free by construction ───────────────────────────
ALTER TABLE email_activities
  ADD CONSTRAINT email_activities_direction_chk CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  ADD CONSTRAINT email_activities_counterpart_email_chk
    CHECK (counterpart_email = lower(counterpart_email) AND position('@' IN counterpart_email) > 1),
  ADD CONSTRAINT email_activities_counterpart_domain_chk CHECK (counterpart_domain = lower(counterpart_domain));

-- Organization-readable; written and deleted only by the mailbox owner's own
-- sync. Rows are immutable (no UPDATE grant).
ALTER TABLE email_activities ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_read ON email_activities FOR SELECT
  USING (organization_id = app_current_organization_id());
CREATE POLICY mailbox_owner_insert ON email_activities FOR INSERT
  WITH CHECK (organization_id = app_current_organization_id() AND mailbox_user_id = app_current_user_id());
CREATE POLICY mailbox_owner_delete ON email_activities FOR DELETE
  USING (organization_id = app_current_organization_id() AND mailbox_user_id = app_current_user_id());
REVOKE ALL ON email_activities FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON email_activities TO tracklibute_app;

-- ─── CRM mirror + health: organization isolation ───────────────────────────
ALTER TABLE crm_owners          ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_owner_mappings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_companies       ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_contacts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_deals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_deal_contacts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_deal_companies  ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_health  ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON crm_owners
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY org_isolation ON crm_owner_mappings
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY org_isolation ON crm_pipeline_stages
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY org_isolation ON crm_companies
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY org_isolation ON crm_contacts
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY org_isolation ON crm_deals
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY org_isolation ON crm_deal_contacts
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY org_isolation ON crm_deal_companies
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY org_isolation ON opportunity_health
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

REVOKE ALL ON crm_owners, crm_owner_mappings, crm_pipeline_stages, crm_companies, crm_contacts,
              crm_deals, crm_deal_contacts, crm_deal_companies, opportunity_health FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_owners          TO tracklibute_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_owner_mappings  TO tracklibute_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_pipeline_stages TO tracklibute_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_companies       TO tracklibute_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_contacts        TO tracklibute_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_deals           TO tracklibute_app;
GRANT SELECT, INSERT, DELETE         ON crm_deal_contacts   TO tracklibute_app;
GRANT SELECT, INSERT, DELETE         ON crm_deal_companies  TO tracklibute_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON opportunity_health  TO tracklibute_app;

-- ─── Which members of the CURRENT organization have Gmail connected ────────
-- Mailbox integrations are owner-private (RLS), but Opportunity Health must
-- know whether a deal owner's activity is visible at all ("limited signal").
-- Returns user ids only, and only for app_current_organization_id().
CREATE FUNCTION app_connected_mailbox_user_ids()
  RETURNS TABLE (user_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT DISTINCT i.owner_user_id
    FROM integrations i
    WHERE i.organization_id = app_current_organization_id()
      AND i.provider = 'GMAIL'
      AND i.status = 'CONNECTED'
      AND i.owner_user_id IS NOT NULL
  $$;

-- Acting identity for scheduled org-wide work: whoever connected the
-- integration if still ADMIN/OWNER, else the earliest OWNER.
CREATE FUNCTION app_org_system_actor(p_organization_id uuid, p_preferred uuid)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT coalesce(
      (SELECT m.user_id FROM organization_members m
        WHERE m.organization_id = p_organization_id AND m.user_id = p_preferred
          AND m.role IN ('OWNER', 'ADMIN')),
      (SELECT m.user_id FROM organization_members m
        WHERE m.organization_id = p_organization_id AND m.role = 'OWNER'
        ORDER BY m.created_at, m.user_id LIMIT 1)
    )
  $$;

-- ─── Cron: due HubSpot portals (ids only; sync then runs under RLS) ────────
CREATE FUNCTION hubspot_sync_candidates(p_limit integer)
  RETURNS TABLE (integration_id uuid, organization_id uuid, actor_user_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT i.id, i.organization_id, app_org_system_actor(i.organization_id, i.connected_by_user_id)
    FROM integrations i
    WHERE i.provider = 'HUBSPOT'
      AND i.status = 'CONNECTED'
      AND i.owner_user_id IS NULL
      AND i.encrypted_credentials IS NOT NULL
      AND (i.sync_lease_expires_at IS NULL OR i.sync_lease_expires_at < now())
    ORDER BY i.last_sync_attempt_at ASC NULLS FIRST
    LIMIT least(greatest(p_limit, 1), 100)
  $$;

-- ─── Cron: organizations whose Opportunity Health is due ───────────────────
CREATE FUNCTION opportunity_health_candidates(p_limit integer)
  RETURNS TABLE (organization_id uuid, responsibility_id uuid, actor_user_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT r.organization_id, r.id, app_org_system_actor(r.organization_id, i.connected_by_user_id)
    FROM responsibilities r
    JOIN integrations i
      ON i.organization_id = r.organization_id AND i.provider = 'HUBSPOT'
     AND i.owner_user_id IS NULL AND i.status = 'CONNECTED'
    WHERE r.template_key = 'opportunity_health'
      AND r.status = 'ACTIVE'
      AND NOT EXISTS (
        SELECT 1 FROM responsibility_runs a
         WHERE a.organization_id = r.organization_id AND a.responsibility_id = r.id
           AND a.status IN ('QUEUED', 'RUNNING') AND a.started_at > now() - interval '15 minutes')
    ORDER BY (SELECT max(x.created_at) FROM responsibility_runs x
               WHERE x.organization_id = r.organization_id AND x.responsibility_id = r.id) ASC NULLS FIRST
    LIMIT least(greatest(p_limit, 1), 100)
  $$;

REVOKE ALL ON FUNCTION app_connected_mailbox_user_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_org_system_actor(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION hubspot_sync_candidates(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION opportunity_health_candidates(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_connected_mailbox_user_ids() TO tracklibute_app;
GRANT EXECUTE ON FUNCTION hubspot_sync_candidates(integer) TO tracklibute_app;
GRANT EXECUTE ON FUNCTION opportunity_health_candidates(integer) TO tracklibute_app;
-- app_org_system_actor is an internal helper of the two candidate functions only.
