-- Spec 05: mirror qualification and activity fields for standalone HubSpot contacts.
ALTER TABLE "crm_contacts"
  ADD COLUMN "lifecycle_stage" TEXT,
  ADD COLUMN "lead_status" TEXT,
  ADD COLUMN "owner_external_id" TEXT,
  ADD COLUMN "external_created_at" TIMESTAMPTZ(3),
  ADD COLUMN "date_entered_sales_qualified_lead" TIMESTAMPTZ(3),
  ADD COLUMN "date_entered_marketing_qualified_lead" TIMESTAMPTZ(3),
  ADD COLUMN "crm_last_activity_at" TIMESTAMPTZ(3),
  ADD COLUMN "crm_last_contacted_at" TIMESTAMPTZ(3),
  ADD COLUMN "next_activity_at" TIMESTAMPTZ(3),
  ADD COLUMN "last_seen_full_sync_at" TIMESTAMPTZ(3);
