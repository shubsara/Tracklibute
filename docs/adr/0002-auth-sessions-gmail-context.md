# ADR 0002 — Production auth, Gmail ingestion, owner-private email context

- **Status:** Accepted
- **Date:** 2026-10-15
- **Scope:** Build Spec 02
- **Builds on:** ADR 0001 (unchanged: Responsibilities, closed action registry, approval gate, tenancy + RLS)

## Decisions

### 1. Google OIDC via `openid-client`, behind the existing `AuthProvider`

- **Choice.** We use `openid-client` 6.x, a certified OpenID Connect library, for
  both sign-in and the Gmail code exchange. Auth.js v5 is still a beta, and it
  would add its own User, Account and Session tables outside our RLS model.
- **What the provider returns.** The `session` provider resolves
  `{ userId, organizationId | null }`. Roles still come from the database on
  every request.
- **Identity key.** Identity is keyed on Google's immutable `sub`. A
  pre-existing user with the same verified email is linked once. Unverified
  emails are refused.
- **The dev provider stays.** It's last in the chain, and it's refused whenever
  `NODE_ENV=production`, whatever the configuration says.

### 2. Database-backed opaque sessions

- **Tokens.** The client holds 32 random bytes. The server stores only
  `HMAC-SHA256(SESSION_SECRET, token)`. That gives revocable logout, no
  readable tokens if the database leaks, and no JWTs to invalidate.
- **Access.** The app role has **no** grants on `sessions`. Create, resolve,
  revoke and organization-binding go through `SECURITY DEFINER` functions,
  the same sanctioned-bypass pattern as ADR 0001's auth lookups.
- **Onboarding.** `app_create_organization_for_session` takes the session
  token hash, never a user id. It creates the organization and the OWNER
  membership, and binds the session in one transaction.

### 3. Sign-in and Gmail are separate consents

- Sign-in requests `openid email profile` only. Gmail is connected
  explicitly with `gmail.readonly`, offline access and `prompt=consent`.
- If extra Gmail scopes are granted, such as send or modify, the connection is
  refused.
- The connected mailbox is whatever Gmail's profile reports, not the
  sign-in email.

### 4. Gmail is an adapter; the domain sees only normalized types

- `src/server/integrations/gmail/` is the only place Gmail response shapes exist.
- The sync service depends on the `MailboxSource` port, and downstream code
  depends on `NormalizedEmailMessage` and `NormalizedEmailContext`.
- Provider errors become domain errors: cursor expired, authorization revoked,
  rate limited, unavailable.
- Gmail ids are external identifiers only. Every row has an internal UUID
  primary key.

### 5. Raw mailbox data is owner-private, enforced twice

- **Ownership on every row.** Every email row carries
  `(organization_id, mailbox_user_id)`.
- **Two independent enforcement layers:**
  - **App:** services always filter on `mailboxUserId = auth.userId`.
  - **RLS:** policies require
    `organization_id = app.organization_id AND mailbox_user_id = app.user_id`.
    User-scoped integrations get the same treatment.
- **Composite foreign keys** make a message's owner equal its integration's
  owner, and make the integration's owner a member of the organization.
- **Member removal** cascades the mailbox away.

Organization-level sales context will be a separate, derived layer in a later
spec. Raw mail never becomes org-readable.

### 6. Sync: pull, idempotent, checkpoint-after-success, leased

- **Initial and recovery syncs:** a bounded backfill, 90 days by default
  (configurable).
- **Incremental:** the Gmail History API.
- **Checkpoint:** the cursor advances only after a successful run, and only
  while the run holds its lease (compare-and-set on `sync_lease_expires_at`).
- **Idempotency:** unique `(integration_id, external_*_id)` constraints make
  re-runs safe.
- **Expired history** produces an explicit `gmail.resync_required`, then a
  recovery backfill. It is never a silent success.
- **Triggers:** "Sync now" and a secret-protected cron endpoint. There is no
  queue, Redis or Pub/Sub at this stage.

### 6a. Quota-aware, resumable backfill (amendment after the real-Gmail test)

The first real-Gmail test stopped after 100 messages. Five unpaced workers
burst past Google's per-user quota: 6,000 units/minute, with `messages.get`
costing 20 units. The 4-second retry window couldn't recover, and every retry
restarted the backfill and re-fetched what was already stored. The fix:

- **Pacing:** a shared quota pacer (80 units/s, 2 workers) and Google's
  truncated exponential backoff (1 s → 32 s).
- **Time-boxed runs:** a run that runs out of budget ends as **partial**,
  which is not a failure.
- **Resume:** the backfill resumes by skipping stored ids.
- **Checkpoint:** `backfill_cursor` keeps the historyId from when the
  backfill started, so the multi-run backfill's final checkpoint is still
  correct.

### 7. Email content is untrusted

Subjects, names, snippets and bodies are external input. They are stored as
plain text and rendered escaped. They are never logged or audited, and they
never influence authorization, actions or configuration. When AI reasoning
arrives, email text must be passed as quoted data, never as instructions.

## Consequences

- **Launch gate.** `gmail.readonly` is a restricted scope, so the external
  launch requires Google verification and a security assessment. That is a
  launch milestone, not an architectural change.
- **Rotating `SESSION_SECRET`** signs out every user, by design.
- **One organization per user** until invitations exist.
- **Adding Outlook later** means a new `MailboxSource` adapter. The email
  model, services and RLS don't change.
