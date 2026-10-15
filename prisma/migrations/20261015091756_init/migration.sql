-- CreateEnum
CREATE TYPE "member_role" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "integration_provider" AS ENUM ('GMAIL', 'HUBSPOT', 'GOOGLE_CALENDAR');

-- CreateEnum
CREATE TYPE "integration_status" AS ENUM ('PENDING', 'CONNECTED', 'ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "responsibility_type" AS ENUM ('SYSTEM', 'CUSTOM');

-- CreateEnum
CREATE TYPE "responsibility_status" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "responsibility_run_status" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "recommendation_severity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "recommendation_status" AS ENUM ('OPEN', 'ACCEPTED', 'DISMISSED', 'SNOOZED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "proposed_action_status" AS ENUM ('PROPOSED', 'APPROVED', 'REJECTED', 'EXECUTING', 'EXECUTED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "action_source" AS ENUM ('SYSTEM', 'AI', 'USER');

-- CreateEnum
CREATE TYPE "approval_decision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "actor_type" AS ENUM ('USER', 'SYSTEM');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "member_role" NOT NULL DEFAULT 'MEMBER',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "provider" "integration_provider" NOT NULL,
    "status" "integration_status" NOT NULL DEFAULT 'PENDING',
    "external_account_id" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "encrypted_credentials" TEXT,
    "connected_by_user_id" UUID,
    "last_synced_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "responsibilities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "type" "responsibility_type" NOT NULL,
    "template_key" TEXT,
    "status" "responsibility_status" NOT NULL DEFAULT 'ACTIVE',
    "owner_user_id" UUID,
    "config" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "responsibilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "responsibility_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "responsibility_id" UUID NOT NULL,
    "status" "responsibility_run_status" NOT NULL DEFAULT 'QUEUED',
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "summary" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "responsibility_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "responsibility_id" UUID NOT NULL,
    "responsibility_run_id" UUID,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "severity" "recommendation_severity" NOT NULL DEFAULT 'MEDIUM',
    "status" "recommendation_status" NOT NULL DEFAULT 'OPEN',
    "subject_ref" JSONB,
    "evidence" JSONB,
    "snoozed_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposed_actions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "recommendation_id" UUID,
    "action_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "requires_approval" BOOLEAN NOT NULL,
    "status" "proposed_action_status" NOT NULL DEFAULT 'PROPOSED',
    "source" "action_source" NOT NULL,
    "created_by_user_id" UUID,
    "result" JSONB,
    "error" TEXT,
    "executed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "proposed_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "proposed_action_id" UUID NOT NULL,
    "decision" "approval_decision" NOT NULL,
    "decided_by_user_id" UUID NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "actor_type" "actor_type" NOT NULL,
    "actor_user_id" UUID,
    "event" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "organization_members_user_id_idx" ON "organization_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_members_organization_id_user_id_key" ON "organization_members"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "integrations_organization_id_provider_idx" ON "integrations"("organization_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_organization_id_provider_external_account_id_key" ON "integrations"("organization_id", "provider", "external_account_id");

-- CreateIndex
CREATE INDEX "responsibilities_organization_id_status_idx" ON "responsibilities"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "responsibilities_organization_id_id_key" ON "responsibilities"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "responsibilities_organization_id_template_key_key" ON "responsibilities"("organization_id", "template_key");

-- CreateIndex
CREATE INDEX "responsibility_runs_organization_id_responsibility_id_creat_idx" ON "responsibility_runs"("organization_id", "responsibility_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "responsibility_runs_organization_id_id_key" ON "responsibility_runs"("organization_id", "id");

-- CreateIndex
CREATE INDEX "recommendations_organization_id_status_idx" ON "recommendations"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "recommendations_organization_id_id_key" ON "recommendations"("organization_id", "id");

-- CreateIndex
CREATE INDEX "proposed_actions_organization_id_status_idx" ON "proposed_actions"("organization_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "proposed_actions_organization_id_id_key" ON "proposed_actions"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "approvals_proposed_action_id_key" ON "approvals"("proposed_action_id");

-- CreateIndex
CREATE UNIQUE INDEX "approvals_organization_id_proposed_action_id_key" ON "approvals"("organization_id", "proposed_action_id");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_entity_type_entity_id_idx" ON "audit_logs"("organization_id", "entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responsibility_runs" ADD CONSTRAINT "responsibility_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "responsibility_runs" ADD CONSTRAINT "responsibility_runs_organization_id_responsibility_id_fkey" FOREIGN KEY ("organization_id", "responsibility_id") REFERENCES "responsibilities"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_organization_id_responsibility_id_fkey" FOREIGN KEY ("organization_id", "responsibility_id") REFERENCES "responsibilities"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_organization_id_responsibility_run_id_fkey" FOREIGN KEY ("organization_id", "responsibility_run_id") REFERENCES "responsibility_runs"("organization_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposed_actions" ADD CONSTRAINT "proposed_actions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposed_actions" ADD CONSTRAINT "proposed_actions_organization_id_recommendation_id_fkey" FOREIGN KEY ("organization_id", "recommendation_id") REFERENCES "recommendations"("organization_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_organization_id_proposed_action_id_fkey" FOREIGN KEY ("organization_id", "proposed_action_id") REFERENCES "proposed_actions"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
