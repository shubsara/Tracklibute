-- Tracklibute Foundation — defense-in-depth guards.
--
-- 1. Runtime role grants (least privilege).
-- 2. Row-Level Security on every tenant-owned table.
-- 3. Narrow SECURITY DEFINER auth lookups (the only sanctioned RLS bypass).
-- 4. Proposed-action state machine + approval gate enforced in the database.
-- 5. Append-only approvals and audit logs.
--
-- The application connects as `tracklibute_app` (no BYPASSRLS, not owner).
-- Migrations run as the schema owner, which is exempt from (non-forced) RLS.
-- RLS is defense in depth: application code still scopes every query and
-- authorizes every operation itself.

-- ─── 0. Preconditions ───────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracklibute_app') THEN
    RAISE EXCEPTION 'Role tracklibute_app must exist before migrating. Run scripts/db-setup.sh (or see README).';
  END IF;
END $$;

-- ─── 1. Request-context helpers ─────────────────────────────────────────────
-- The app sets these with set_config(..., is_local => true) at the start of
-- every org-scoped transaction. Unset => NULL => RLS matches no rows.

CREATE FUNCTION app_current_organization_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.organization_id', true), '')::uuid $$;

CREATE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

-- ─── 2. Grants ──────────────────────────────────────────────────────────────

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO tracklibute_app;

GRANT SELECT                         ON users                TO tracklibute_app;
GRANT SELECT, UPDATE                 ON organizations        TO tracklibute_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON organization_members TO tracklibute_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON integrations         TO tracklibute_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON responsibilities     TO tracklibute_app;
GRANT SELECT, INSERT, UPDATE         ON responsibility_runs  TO tracklibute_app;
GRANT SELECT, INSERT, UPDATE         ON recommendations      TO tracklibute_app;
GRANT SELECT, INSERT, UPDATE         ON proposed_actions     TO tracklibute_app;
GRANT SELECT, INSERT                 ON approvals            TO tracklibute_app; -- immutable
GRANT SELECT, INSERT                 ON audit_logs           TO tracklibute_app; -- append-only
GRANT EXECUTE ON FUNCTION app_current_organization_id(), app_current_user_id() TO tracklibute_app;

-- ─── 3. Row-Level Security ──────────────────────────────────────────────────

ALTER TABLE organizations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE users                ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE responsibilities     ENABLE ROW LEVEL SECURITY;
ALTER TABLE responsibility_runs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposed_actions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals            ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs           ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON organizations
  USING (id = app_current_organization_id())
  WITH CHECK (id = app_current_organization_id());

-- Users are global, but a session may only see itself and members of its current org.
CREATE POLICY org_member_visibility ON users FOR SELECT
  USING (
    id = app_current_user_id()
    OR EXISTS (SELECT 1 FROM organization_members m WHERE m.user_id = users.id)
  );

CREATE POLICY org_isolation ON organization_members
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY org_isolation ON integrations
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY org_isolation ON responsibilities
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY org_isolation ON responsibility_runs
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY org_isolation ON recommendations
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY org_isolation ON proposed_actions
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY org_isolation ON approvals
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());
CREATE POLICY org_isolation ON audit_logs
  USING (organization_id = app_current_organization_id())
  WITH CHECK (organization_id = app_current_organization_id());

-- ─── 4. Auth lookups (the only sanctioned RLS bypass) ───────────────────────
-- Authentication must resolve membership *before* an org context exists.
-- These run as the owner, return only the minimum needed, and take no
-- org id from anything other than an already-authenticated identity.

CREATE FUNCTION auth_resolve_membership(p_user_id uuid, p_organization_id uuid)
  RETURNS member_role
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT m.role FROM organization_members m
    WHERE m.user_id = p_user_id AND m.organization_id = p_organization_id
  $$;

-- Dev-login helper: resolves (email, org slug) to an identity only if the
-- user is actually a member of that organization.
CREATE FUNCTION auth_resolve_login(p_email text, p_organization_slug text)
  RETURNS TABLE (user_id uuid, organization_id uuid, role member_role)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT u.id, o.id, m.role
    FROM users u
    JOIN organization_members m ON m.user_id = u.id
    JOIN organizations o ON o.id = m.organization_id
    WHERE lower(u.email) = lower(p_email) AND o.slug = p_organization_slug
  $$;

REVOKE ALL ON FUNCTION auth_resolve_membership(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_resolve_login(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_resolve_membership(uuid, uuid) TO tracklibute_app;
GRANT EXECUTE ON FUNCTION auth_resolve_login(text, text) TO tracklibute_app;

-- ─── 5. Proposed-action state machine + approval gate ───────────────────────
--
--   PROPOSED ──approve──▶ APPROVED ──claim──▶ EXECUTING ──▶ EXECUTED | FAILED
--      │ └──reject──▶ REJECTED                   ▲
--      └──claim (only if requires_approval = false)┘
--   PROPOSED | APPROVED ──▶ CANCELLED
--
-- Terminal: REJECTED, EXECUTED, FAILED, CANCELLED (row becomes immutable).
-- Entering APPROVED or EXECUTING on a consequential action requires an
-- APPROVED row in `approvals`. Identity/payload fields are immutable.

CREATE FUNCTION enforce_proposed_action_insert() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'PROPOSED' THEN
    RAISE EXCEPTION 'proposed_actions must be created in PROPOSED status (got %)', NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.executed_at IS NOT NULL OR NEW.result IS NOT NULL THEN
    RAISE EXCEPTION 'proposed_actions cannot be created with execution results'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION enforce_proposed_action_transition() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_approved boolean;
  v_rejected boolean;
BEGIN
  IF OLD.status IN ('REJECTED', 'EXECUTED', 'FAILED', 'CANCELLED') THEN
    RAISE EXCEPTION 'proposed action % is in terminal status % and cannot change', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.action_type IS DISTINCT FROM OLD.action_type
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.requires_approval IS DISTINCT FROM OLD.requires_approval
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.recommendation_id IS DISTINCT FROM OLD.recommendation_id THEN
    RAISE EXCEPTION 'proposed action identity, type, payload and approval requirement are immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(bool_or(a.decision = 'APPROVED'), false),
         coalesce(bool_or(a.decision = 'REJECTED'), false)
    INTO v_approved, v_rejected
    FROM approvals a
   WHERE a.proposed_action_id = NEW.id AND a.organization_id = NEW.organization_id;

  IF OLD.status = 'PROPOSED' AND NEW.status = 'APPROVED' THEN
    IF NOT v_approved THEN
      RAISE EXCEPTION 'cannot approve action % without an APPROVED approval record', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.status = 'PROPOSED' AND NEW.status = 'REJECTED' THEN
    IF NOT v_rejected THEN
      RAISE EXCEPTION 'cannot reject action % without a REJECTED approval record', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.status IN ('PROPOSED', 'APPROVED') AND NEW.status = 'EXECUTING' THEN
    IF OLD.requires_approval AND NOT v_approved THEN
      RAISE EXCEPTION 'action % requires approval before execution', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.status = 'EXECUTING' AND NEW.status IN ('EXECUTED', 'FAILED') THEN
    NULL; -- allowed
  ELSIF OLD.status IN ('PROPOSED', 'APPROVED') AND NEW.status = 'CANCELLED' THEN
    NULL; -- allowed
  ELSE
    RAISE EXCEPTION 'illegal proposed action transition % -> % for %', OLD.status, NEW.status, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER proposed_actions_insert_guard
  BEFORE INSERT ON proposed_actions
  FOR EACH ROW EXECUTE FUNCTION enforce_proposed_action_insert();

CREATE TRIGGER proposed_actions_transition_guard
  BEFORE UPDATE ON proposed_actions
  FOR EACH ROW EXECUTE FUNCTION enforce_proposed_action_transition();

-- ─── 6. Approvals: decided only while PROPOSED, by a member, never edited ───

CREATE FUNCTION enforce_approval_insert() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  v_status proposed_action_status;
BEGIN
  SELECT pa.status INTO v_status
    FROM proposed_actions pa
   WHERE pa.id = NEW.proposed_action_id AND pa.organization_id = NEW.organization_id
   FOR UPDATE;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'proposed action % not found in organization', NEW.proposed_action_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_status <> 'PROPOSED' THEN
    RAISE EXCEPTION 'proposed action % is % and can no longer be decided', NEW.proposed_action_id, v_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM organization_members m
     WHERE m.organization_id = NEW.organization_id
       AND m.user_id = NEW.decided_by_user_id
       AND m.role IN ('OWNER', 'ADMIN', 'MEMBER')
  ) THEN
    RAISE EXCEPTION 'user % is not allowed to decide actions in this organization', NEW.decided_by_user_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION reject_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER approvals_insert_guard
  BEFORE INSERT ON approvals
  FOR EACH ROW EXECUTE FUNCTION enforce_approval_insert();

CREATE TRIGGER approvals_immutable
  BEFORE UPDATE OR DELETE ON approvals
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- ─── 7. Audit log: append-only ──────────────────────────────────────────────
-- Row-level trigger blocks UPDATE/DELETE for every role. Organization deletion
-- cascades are statement-internal FK actions and also hit this trigger, which
-- is intentional: organizations are not hard-deleted in the MVP.

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
