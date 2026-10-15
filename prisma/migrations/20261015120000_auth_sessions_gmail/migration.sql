-- CreateEnum
CREATE TYPE "email_direction" AS ENUM ('INBOUND', 'OUTBOUND', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "email_recipient_kind" AS ENUM ('TO', 'CC', 'BCC');

-- AlterEnum
ALTER TYPE "integration_status" ADD VALUE 'REAUTH_REQUIRED';

-- AlterTable
ALTER TABLE "integrations" ADD COLUMN     "last_sync_attempt_at" TIMESTAMPTZ(3),
ADD COLUMN     "owner_user_id" UUID,
ADD COLUMN     "sync_cursor" TEXT,
ADD COLUMN     "sync_lease_expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "token_expires_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "google_subject" TEXT;

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_threads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "mailbox_user_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "external_thread_id" TEXT NOT NULL,
    "subject" TEXT,
    "first_message_at" TIMESTAMPTZ(3) NOT NULL,
    "last_message_at" TIMESTAMPTZ(3) NOT NULL,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "email_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "mailbox_user_id" UUID NOT NULL,
    "integration_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "external_message_id" TEXT NOT NULL,
    "external_thread_id" TEXT NOT NULL,
    "from_email" TEXT,
    "from_name" TEXT,
    "subject" TEXT,
    "snippet" TEXT,
    "body_text" TEXT,
    "body_truncated" BOOLEAN NOT NULL DEFAULT false,
    "sent_at" TIMESTAMPTZ(3),
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "direction" "email_direction" NOT NULL,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "headers" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_message_recipients" (
    "organization_id" UUID NOT NULL,
    "mailbox_user_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "kind" "email_recipient_kind" NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,

    CONSTRAINT "email_message_recipients_pkey" PRIMARY KEY ("message_id","kind","email")
);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "email_threads_organization_id_mailbox_user_id_last_message__idx" ON "email_threads"("organization_id", "mailbox_user_id", "last_message_at" DESC, "id");

-- CreateIndex
CREATE UNIQUE INDEX "email_threads_integration_id_external_thread_id_key" ON "email_threads"("integration_id", "external_thread_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_threads_organization_id_integration_id_mailbox_user_i_key" ON "email_threads"("organization_id", "integration_id", "mailbox_user_id", "id");

-- CreateIndex
CREATE INDEX "email_messages_thread_id_received_at_idx" ON "email_messages"("thread_id", "received_at");

-- CreateIndex
CREATE INDEX "email_messages_organization_id_mailbox_user_id_received_at_idx" ON "email_messages"("organization_id", "mailbox_user_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_integration_id_external_message_id_key" ON "email_messages"("integration_id", "external_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_organization_id_mailbox_user_id_id_key" ON "email_messages"("organization_id", "mailbox_user_id", "id");

-- CreateIndex
CREATE INDEX "email_message_recipients_organization_id_mailbox_user_id_em_idx" ON "email_message_recipients"("organization_id", "mailbox_user_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_organization_id_provider_owner_user_id_key" ON "integrations"("organization_id", "provider", "owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_organization_id_id_owner_user_id_key" ON "integrations"("organization_id", "id", "owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_google_subject_key" ON "users"("google_subject");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_owner_user_id_fkey" FOREIGN KEY ("organization_id", "owner_user_id") REFERENCES "organization_members"("organization_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_integration_owner_fkey" FOREIGN KEY ("organization_id", "integration_id", "mailbox_user_id") REFERENCES "integrations"("organization_id", "id", "owner_user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_integration_owner_fkey" FOREIGN KEY ("organization_id", "integration_id", "mailbox_user_id") REFERENCES "integrations"("organization_id", "id", "owner_user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_thread_owner_fkey" FOREIGN KEY ("organization_id", "integration_id", "mailbox_user_id", "thread_id") REFERENCES "email_threads"("organization_id", "integration_id", "mailbox_user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_message_recipients" ADD CONSTRAINT "email_message_recipients_organization_id_mailbox_user_id_m_fkey" FOREIGN KEY ("organization_id", "mailbox_user_id", "message_id") REFERENCES "email_messages"("organization_id", "mailbox_user_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- Hand-written guards (Build Spec 02). Same model as `rls_and_guards`:
-- the runtime role is subject to RLS; SECURITY DEFINER functions are the only
-- sanctioned bypasses and each returns the minimum it must.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Sessions: no direct access for the runtime role ────────────────────────
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sessions FROM PUBLIC;
-- (intentionally no GRANT to tracklibute_app and no policies)

-- ─── Integrations: user-scoped rows (mailboxes) are visible only to their owner
DROP POLICY org_isolation ON integrations;
CREATE POLICY org_owner_isolation ON integrations
  USING (
    organization_id = app_current_organization_id()
    AND (owner_user_id IS NULL OR owner_user_id = app_current_user_id())
  )
  WITH CHECK (
    organization_id = app_current_organization_id()
    AND (owner_user_id IS NULL OR owner_user_id = app_current_user_id())
  );

-- ─── Email context: owner-private (organization AND mailbox owner) ─────────
ALTER TABLE email_threads            ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_messages           ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_message_recipients ENABLE ROW LEVEL SECURITY;

CREATE POLICY mailbox_owner_isolation ON email_threads
  USING (organization_id = app_current_organization_id() AND mailbox_user_id = app_current_user_id())
  WITH CHECK (organization_id = app_current_organization_id() AND mailbox_user_id = app_current_user_id());
CREATE POLICY mailbox_owner_isolation ON email_messages
  USING (organization_id = app_current_organization_id() AND mailbox_user_id = app_current_user_id())
  WITH CHECK (organization_id = app_current_organization_id() AND mailbox_user_id = app_current_user_id());
CREATE POLICY mailbox_owner_isolation ON email_message_recipients
  USING (organization_id = app_current_organization_id() AND mailbox_user_id = app_current_user_id())
  WITH CHECK (organization_id = app_current_organization_id() AND mailbox_user_id = app_current_user_id());

REVOKE ALL ON email_threads, email_messages, email_message_recipients FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON email_threads            TO tracklibute_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON email_messages           TO tracklibute_app;
GRANT SELECT, INSERT, DELETE         ON email_message_recipients TO tracklibute_app;

-- ─── Auth: Google identity → user ──────────────────────────────────────────
-- Identity is keyed on the immutable Google `sub`. A pre-existing user with
-- the same (verified) email and no linked subject is linked once.
CREATE FUNCTION auth_upsert_google_user(p_subject text, p_email text, p_name text)
  RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_id uuid;
BEGIN
  IF coalesce(p_subject, '') = '' OR coalesce(p_email, '') = '' THEN
    RAISE EXCEPTION 'subject and email are required' USING ERRCODE = 'check_violation';
  END IF;

  SELECT id INTO v_id FROM users WHERE google_subject = p_subject;
  IF v_id IS NOT NULL THEN
    UPDATE users SET name = coalesce(p_name, name), updated_at = now() WHERE id = v_id;
    RETURN v_id;
  END IF;

  SELECT id INTO v_id FROM users
   WHERE lower(email) = lower(p_email) AND google_subject IS NULL
   FOR UPDATE;
  IF v_id IS NOT NULL THEN
    UPDATE users SET google_subject = p_subject, name = coalesce(name, p_name), updated_at = now()
     WHERE id = v_id;
    RETURN v_id;
  END IF;

  INSERT INTO users (email, name, google_subject, updated_at)
  VALUES (lower(p_email), p_name, p_subject, now())
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ─── Auth: opaque sessions (only token HMACs are ever stored) ──────────────
-- A new session binds to the user's earliest organization membership, if any.
-- The organization is never supplied by the client.
CREATE FUNCTION auth_create_session(p_user_id uuid, p_token_hash text, p_expires_at timestamptz)
  RETURNS TABLE (session_id uuid, organization_id uuid)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    INSERT INTO sessions (token_hash, user_id, organization_id, expires_at)
    VALUES (
      p_token_hash,
      p_user_id,
      (SELECT m.organization_id FROM organization_members m
        WHERE m.user_id = p_user_id
        ORDER BY m.created_at, m.organization_id
        LIMIT 1),
      p_expires_at
    )
    RETURNING id, organization_id
  $$;

-- Valid (unrevoked, unexpired) session → identity. `role` is NULL when the
-- session has no organization yet or the membership no longer exists.
CREATE FUNCTION auth_resolve_session(p_token_hash text)
  RETURNS TABLE (session_id uuid, user_id uuid, organization_id uuid, role member_role)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT s.id, s.user_id, s.organization_id, m.role
    FROM sessions s
    LEFT JOIN organization_members m
      ON m.organization_id = s.organization_id AND m.user_id = s.user_id
    WHERE s.token_hash = p_token_hash
      AND s.revoked_at IS NULL
      AND s.expires_at > now()
  $$;

CREATE FUNCTION auth_revoke_session(p_token_hash text)
  RETURNS boolean
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    WITH r AS (
      UPDATE sessions SET revoked_at = now()
       WHERE token_hash = p_token_hash AND revoked_at IS NULL
      RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM r)
  $$;

-- ─── Onboarding: create an organization for the session's user ─────────────
-- Identity comes from the session token, never from a user id argument.
-- Refused if the user already belongs to an organization (no invitations yet).
CREATE FUNCTION app_create_organization_for_session(p_token_hash text, p_name text, p_slug text)
  RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_session sessions%ROWTYPE;
  v_org uuid;
BEGIN
  SELECT * INTO v_session FROM sessions
   WHERE token_hash = p_token_hash AND revoked_at IS NULL AND expires_at > now()
   FOR UPDATE;
  IF v_session.id IS NULL THEN
    RAISE EXCEPTION 'invalid session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_session.organization_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM organization_members WHERE user_id = v_session.user_id) THEN
    RAISE EXCEPTION 'user already belongs to an organization' USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO organizations (name, slug, updated_at) VALUES (p_name, p_slug, now())
  RETURNING id INTO v_org;
  INSERT INTO organization_members (organization_id, user_id, role, updated_at)
  VALUES (v_org, v_session.user_id, 'OWNER', now());
  UPDATE sessions SET organization_id = v_org WHERE id = v_session.id;
  RETURN v_org;
END $$;

-- ─── Cron: which mailboxes are due (ids only; sync then runs under RLS) ────
CREATE FUNCTION gmail_sync_candidates(p_limit integer)
  RETURNS TABLE (integration_id uuid, organization_id uuid, owner_user_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT i.id, i.organization_id, i.owner_user_id
    FROM integrations i
    WHERE i.provider = 'GMAIL'
      AND i.status = 'CONNECTED'
      AND i.owner_user_id IS NOT NULL
      AND i.encrypted_credentials IS NOT NULL
      AND (i.sync_lease_expires_at IS NULL OR i.sync_lease_expires_at < now())
    ORDER BY i.last_sync_attempt_at ASC NULLS FIRST
    LIMIT least(greatest(p_limit, 1), 100)
  $$;

REVOKE ALL ON FUNCTION auth_upsert_google_user(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_create_session(uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_resolve_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_revoke_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_create_organization_for_session(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION gmail_sync_candidates(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_upsert_google_user(text, text, text) TO tracklibute_app;
GRANT EXECUTE ON FUNCTION auth_create_session(uuid, text, timestamptz) TO tracklibute_app;
GRANT EXECUTE ON FUNCTION auth_resolve_session(text) TO tracklibute_app;
GRANT EXECUTE ON FUNCTION auth_revoke_session(text) TO tracklibute_app;
GRANT EXECUTE ON FUNCTION app_create_organization_for_session(text, text, text) TO tracklibute_app;
GRANT EXECUTE ON FUNCTION gmail_sync_candidates(integer) TO tracklibute_app;
