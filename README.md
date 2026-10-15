# Tracklibute

**AI Sales Operations for small B2B teams.**
Core promise: *qualified leads and active opportunities don't go cold.*

Tracklibute owns a small set of sales **Responsibilities**: Lead Health,
Opportunity Health, Follow-up, CRM Hygiene and Meeting Readiness. It watches
Gmail, HubSpot and Google Calendar, raises **Recommendations**, and proposes
**Actions** that a human approves before anything consequential happens.

> **Current stage: Build Spec 02.** This stage adds production authentication,
> Gmail OAuth, Gmail ingestion and normalized, owner-private email context.
> There is no AI, no detection logic and no email sending yet.

---

## Architecture overview

```
 Browser ──▶ AuthProvider chain
              ├─ session  : opaque DB session (Google sign-in via openid-client)
              └─ dev      : signed dev token (local/tests only; refused in production)
              │ { userId, organizationId | null }
              ▼
           contextFromIdentity ── re-verifies membership + role in DB every request
              │ AuthContext { userId, organizationId, role }
              ▼
           Services ── role checks + explicit organization / mailbox-owner filters
              ▼
           withOrgScope(tx) ── SET LOCAL app.organization_id, app.user_id → RLS
              ▼
           PostgreSQL (runtime role: no superuser, no BYPASSRLS, not owner)
```

Gmail data flow. Gmail shapes never leave `src/server/integrations/gmail/`.

```
 Gmail REST (fields-masked) ─▶ gmail.client ─▶ gmail.mapper ─▶ NormalizedEmailMessage (domain)
                                                    │
 GmailSyncService ◀── MailboxSource port ◀──────────┘
   lease → initial | incremental (History API) | recovery → idempotent upserts → cursor
   ▼
 EmailThread / EmailMessage / EmailMessageRecipient   (owner-private, RLS)
   ▼
 email.service ─▶ /api/email/threads ─▶ UI         NormalizedEmailContext ─▶ future engines
```

Action pipeline (unchanged from Foundation; the only way anything leaves Tracklibute):

```
 AI / responsibility / user ─▶ ProposedAction ─▶ ActionRegistry (closed) ─▶ policy
   ─▶ Approval (if consequential, DB-enforced) ─▶ Executor ─▶ provider adapter
```

| Layer | Path | Notes |
|---|---|---|
| Domain (pure) | `src/domain/` | AuthContext and roles, responsibilities, action registry, integration contracts, **email model, participants, direction, body normalizer, NormalizedEmailContext** |
| Auth | `src/server/auth/` | Provider chain, opaque sessions, Google OIDC, OAuth state cookie, dev provider |
| Gmail adapter | `src/server/integrations/gmail/` | Client, mapper, OAuth, adapter, connection, sync and cron services |
| Email reads | `src/server/email/` | Owner-scoped thread list and detail, plus email context |
| HTTP | `src/app/api/` | Thin handlers. `authedRoute` derives identity and checks Origin on writes. |
| Schema | `prisma/schema.prisma` | Prisma 7, generated client in `src/generated/prisma` |
| DB guards | `prisma/migrations/*_rls_and_guards`, `*_auth_sessions_gmail` | RLS, grants, `SECURITY DEFINER` lookups, state machine |
| Decisions | `docs/adr/` | 0001 Foundation · 0002 Auth + Gmail |

### Data model

| Model | Purpose |
|---|---|
| `Organization` | The tenant. One naming concept throughout: Organization. |
| `User` | Global identity, keyed to Google by `googleSubject` (OIDC `sub`). |
| `OrganizationMember` | User ↔ Organization with role `OWNER` / `ADMIN` / `MEMBER` / `VIEWER` |
| `Session` | Opaque DB session. Only an HMAC of the token is stored, and the app role has no table access. |
| `Integration` | Provider connection: encrypted credentials, `ownerUserId` for personal mailboxes, sync state (`syncCursor`, `lastSyncedAt`, `lastSyncAttemptAt`, `syncLeaseExpiresAt`, `tokenExpiresAt`, `lastError`). |
| `EmailThread` | One conversation per `(integration, externalThreadId)`. Internal UUID primary key. |
| `EmailMessage` | One normalized message per `(integration, externalMessageId)`: from, subject, snippet, capped plain-text body, sent/received times, direction, system labels, allow-listed headers |
| `EmailMessageRecipient` | TO / CC / BCC participants (lowercased email, optional name) |
| `Responsibility`, `ResponsibilityRun`, `Recommendation` | Core abstraction, from Foundation |
| `ProposedAction`, `Approval`, `AuditLog` | Approval-gated actions and an append-only trail, from Foundation |

### Roles

| Capability | VIEWER | MEMBER | ADMIN | OWNER |
|---|:-:|:-:|:-:|:-:|
| Read org data | ✓ | ✓ | ✓ | ✓ |
| Connect **own** Gmail, sync, read **own** mailbox | | ✓ | ✓ | ✓ |
| Propose / approve / execute actions | | ✓ | ✓ | ✓ |
| Manage responsibilities and org-wide integration credentials | | | ✓ | ✓ |

**No role can read another member's mailbox, OWNER included.**

---

## Local setup

**Requirements:** Node ≥ 22.18, pnpm 10 (`corepack enable`), PostgreSQL 16. Docker is not required.

```bash
pnpm install                       # also runs `prisma generate`
cp .env.example .env               # fill in the secrets (see below)
```

### PostgreSQL setup

```bash
# Ubuntu/Debian: sudo pg_ctlcluster 16 main start
# macOS (Homebrew): brew services start postgresql@16
pnpm db:setup        # idempotent; uses `sudo -u postgres psql` (override with PSQL="psql -U postgres")
```

| Role | Used by | Privileges |
|---|---|---|
| `tracklibute_owner` | migrations, seed, test fixtures | owns the schema, exempt from RLS |
| `tracklibute_app` | the running application | `NOSUPERUSER NOBYPASSRLS`, table-level grants only |

Databases: `tracklibute_dev` (development) and `tracklibute_test` (tests only).

### Google Cloud setup (sign-in + Gmail)

1. In the Google Cloud Console, create a project, then enable the **Gmail API**.
2. Configure the **OAuth consent screen**:
   - User type **External**, status **Testing**.
   - Add each tester's Google account under **Test users** (up to 100).
   - Add the scopes `openid`, `email`, `profile` and `https://www.googleapis.com/auth/gmail.readonly`.
3. Go to **Credentials → Create OAuth client ID → Web application**. Add both redirect URIs:
   - `http://localhost:3000/api/auth/google/callback` (sign-in)
   - `http://localhost:3000/api/integrations/gmail/callback` (Gmail connect)
4. Put the client ID and secret into `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

> ⚠️ **`gmail.readonly` is a Google *restricted* scope.** Rolling out to
> external users in production requires Google OAuth app verification. Because
> Tracklibute stores email data on its servers, it also requires the associated
> third-party security assessment, which must be renewed periodically. In
> **Testing** mode, access is limited to listed test users, and Google expires
> their refresh tokens after about 7 days. When that happens, Tracklibute marks
> the mailbox **Reconnection required**. An **Internal** app (users within your
> own Google Workspace) is not subject to external verification.
> Do not try to bypass verification. Plan it as a launch milestone.

### Environment variables

| Variable | Required | Description |
|---|:-:|---|
| `DATABASE_URL` | ✓ | Runtime connection as `tracklibute_app` |
| `DATABASE_OWNER_URL` | ✓ (tooling) | Owner connection for migrate, seed and tests. Never used by the app. |
| `CREDENTIALS_ENCRYPTION_KEY` | ✓ | 32 bytes, base64 (`openssl rand -base64 32`) |
| `SESSION_SECRET` | ✓ | ≥ 32 chars. Keys session-token hashes, dev tokens and OAuth state cookies. Rotating it signs everyone out. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | for Google | OAuth client. Without them, Google features return 503 "not configured". |
| `GOOGLE_REDIRECT_URI` | for sign-in | Must exactly match the sign-in redirect registered at Google |
| `GMAIL_REDIRECT_URI` | for Gmail | Must exactly match the Gmail redirect registered at Google |
| `GMAIL_SYNC_CRON_SECRET` | for cron | ≥ 32 chars (`openssl rand -hex 32`) |
| `GMAIL_SYNC_LOOKBACK_DAYS` | | Initial and recovery backfill window, 1–365 (default **90**) |
| `DEV_AUTH_ENABLED` | | `true` enables dev login. Always refused when `NODE_ENV=production`. |

Tests read `.env.test`: the same keys, pointing at `tracklibute_test`. Create it with
`sed 's/tracklibute_dev/tracklibute_test/g' .env > .env.test`.

### Database migrations

```bash
pnpm db:migrate      # prisma migrate dev: apply + create new migrations (development)
pnpm db:deploy       # prisma migrate deploy: apply pending migrations (CI/production)
pnpm db:reset        # drop and re-create the dev database (destructive)
pnpm db:generate     # regenerate the Prisma client
```

`migrate dev` asks for interactive confirmation when a migration adds unique
constraints. In non-interactive shells, generate SQL with
`prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`,
review it, and append any hand-written guards to the new migration.

### Seed

```bash
pnpm db:seed         # idempotent
```

The seed creates two organizations:
- `acme`: alice@acme.test (OWNER), bob@acme.test (MEMBER), vera@acme.test (VIEWER)
- `globex`: gina@globex.test (OWNER)

Each gets the five SYSTEM responsibilities, org-wide HubSpot and Calendar placeholders, and one sample recommendation and proposed action. Gmail isn't seeded: each user connects their own.

### Development

```bash
pnpm dev                                   # http://localhost:3000
```

- **Sign in:** open `/login` and choose "Sign in with Google". A new user lands on "Create your organization" and becomes OWNER.
- **Dev sign-in** (local only): use `/dev/login`, or run `pnpm dev:token alice@acme.test acme` for a bearer token.
- **Connect Gmail:** go to Integrations, click Connect Gmail and consent to read-only access. The first 90-day sync runs after the redirect. After that, use **Sync now** or the cron.
- **View mail:** open Email to see your own threads and messages.

Run the cron locally:

```bash
curl -X POST -H "Authorization: Bearer $GMAIL_SYNC_CRON_SECRET" localhost:3000/api/internal/cron/gmail-sync
```

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/health` | public | Liveness and database connectivity |
| `GET /api/auth/google/login` · `GET …/callback` | public | Google sign-in (identity only) |
| `POST /api/auth/logout` | session | Revokes the server-side session |
| `POST /api/organizations` | session, no org | Onboarding: create an org and become OWNER |
| `GET /api/me` | session | User, organization and role, all server-derived |
| `GET /api/integrations` | session | Org-wide integrations plus your own. Never credentials. |
| `GET /api/integrations/gmail` | MEMBER+ | Your Gmail connection status |
| `GET /api/integrations/gmail/connect` · `GET …/callback` | MEMBER+ | Gmail OAuth (read-only, PKCE, state bound to your session) |
| `POST /api/integrations/gmail/sync` | MEMBER+ | Sync now (your mailbox only) |
| `DELETE /api/integrations/gmail` | MEMBER+ | Disconnect (revokes at Google) |
| `GET /api/email/threads?limit&cursor` | session | Your threads, keyset-paginated (max 50), no bodies |
| `GET /api/email/threads/:id` | session | One of your threads with normalized messages |
| `POST /api/internal/cron/gmail-sync` | `Bearer` cron secret | Syncs up to 10 due mailboxes |
| `GET/POST /api/responsibilities` | session / ADMIN+ | From Foundation |
| `POST/DELETE /api/dev/session` | dev only | Dev sign-in/out. Returns 403 in production. |

### Tests and quality gates

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Tests run against `tracklibute_test` and never call real Google. `tests/support/fake-google.ts`
is an in-process fake of Google's OIDC discovery, JWKS, token and revoke endpoints
and the Gmail REST API, with failure injection.

| Suite | Proves |
|---|---|
| `auth-session` | Sign-in, onboarding to OWNER, server-derived org, logout revokes, hashed tokens, CSRF, dev auth off in production |
| `gmail-oauth` | Read-only PKCE auth URL, state/CSRF, session binding, scope enforcement, encrypted credentials, disconnect, revoked → reauth |
| `gmail-adapter` | Listing, message, thread, history, parsing, MIME, retries/rate limits, token refresh, typed errors |
| `gmail-sync` | 90-day and custom lookback, batching, incremental history, deletions, idempotency, failure keeps cursor, history-expiry recovery, concurrency lease |
| `email-isolation` | Org A vs B **and** member vs member in one org, at app and RLS layers. URL/body tampering, composite FKs, cron secret, member removal. |
| `security` | No tokens, codes or bodies in responses, logs or audit. RLS on every table. Composite FKs. Email content triggers nothing. |
| Foundation suites | Tenancy, approval gate, API, integrations, units |

---

## Gmail sync behavior

- **Initial sync:** messages newer than `GMAIL_SYNC_LOOKBACK_DAYS` (default 90),
  listed in pages of 100 and fetched with concurrency 5. The checkpoint is the
  mailbox `historyId`, captured **before** the backfill, so concurrent changes
  are picked up next time.
- **Incremental sync:** Gmail History API since the stored checkpoint. Added and
  relabelled messages are re-fetched. Deleted, trashed or spammed messages are
  removed locally, and empty threads are dropped.
- **Checkpoint safety:** the cursor is committed only after every change is
  processed, and only while the run still holds its lease. A failed run leaves
  the old cursor, so a rerun is safe because all writes are idempotent:
  - unique `(integrationId, externalMessageId)` for messages
  - unique `(integrationId, externalThreadId)` for threads
- **Expired history:** when Gmail returns 404 for the cursor, Tracklibute:
  - records `gmail.resync_required` and a `lastError`
  - runs a **bounded recovery backfill** over the lookback window
  - sets a fresh cursor

  It never reports a failed incremental sync as successful.
- **Concurrency:** a single-row lease (`syncLeaseExpiresAt`, 10 min, extended
  per batch) admits one run per mailbox. A crashed run's lease expires and is
  reclaimable.
- **Tokens:**
  - Access tokens refresh 60 s before expiry; a 401 forces one refresh.
  - If Google rejects the refresh (`invalid_grant`), the integration becomes
    `REAUTH_REQUIRED`. The row and data are kept, and the user must reconnect.
- **Not ingested:** drafts, spam, trash and chat. Only allow-listed system
  labels and headers are stored.
- **Bodies:** `text/plain` is preferred, with HTML converted to plain text as a
  fallback. Whitespace is normalized and the body is capped at **50,000 chars**
  (`bodyTruncated` is set when the cap applies). There's no AI and no summarization.

---

## Security model

- **Authentication boundary:** `AuthContext` comes from a server-side session plus
  a DB membership check. Client-supplied `organizationId`, `userId` or
  `mailboxUserId` are never trusted.
- **Sessions:**
  - The token is 32 random bytes. Only HMAC-SHA256 (`SESSION_SECRET`) is stored.
  - Sessions expire after 30 days, and logout revokes them server-side.
  - The cookie is HttpOnly and SameSite=Lax, and Secure in production.
  - State-changing requests with a foreign `Origin` are rejected.
- **Sign-in and Gmail are separate consents.** Sign-in requests identity scopes
  only. Gmail is connected explicitly with `gmail.readonly`; send, modify and
  compose are never requested, and granted extras are refused.
- **OAuth:** both flows use PKCE (S256), `state` and `nonce` in an HMAC-signed,
  10-minute, HttpOnly cookie, and ID-token validation by `openid-client`. The
  Gmail transaction is bound to the user and org that started it.
- **Organization isolation:** app-layer filters plus RLS on
  `organization_id`, plus composite `(organization_id, …)` foreign keys.
- **Mailbox privacy:** raw synced mail is visible **only to the mailbox owner**:
  - App services always filter on `mailboxUserId = auth.userId`.
  - RLS on the email tables and on user-scoped integrations requires
    `mailbox_user_id = app.user_id`.
  - Composite FKs force a message's owner to equal its integration's owner.
  - Removing a member cascades away their mailbox data.
- **Credentials:** encrypted with AES-256-GCM, with AAD bound to the org and
  integration. They are decrypted only in the adapter's token provider, and never
  returned, logged or audited.
- **Untrusted content:** email text is data, rendered as plain text. It never
  changes authorization, invokes actions, or edits responsibility or org
  configuration. This matters once AI arrives.
- **Logs and audit:** structured JSON lines with key-based redaction. Bodies,
  snippets, tokens, codes and session tokens are never written.

> ⚠️ **Not production secret management yet.** `CREDENTIALS_ENCRYPTION_KEY`,
> `SESSION_SECRET` and `GMAIL_SYNC_CRON_SECRET` come from environment variables.
> Production must load them from a managed secret store or KMS (e.g. GCP Secret
> Manager, AWS KMS, Doppler) with rotation, and must keep `DATABASE_OWNER_URL`
> out of the runtime environment.

Production database (provisional): Neon PostgreSQL. Everything here is standard
PostgreSQL. Create a `tracklibute_app` role without `BYPASSRLS` before running
`pnpm db:deploy` as the owner.

---

## Scope

### Done

- **Foundation (Spec 01):**
  - multi-tenancy with RLS and roles
  - the Responsibility model
  - recommendations, a closed action registry and a DB-enforced approval gate
  - an audit log and the integration abstraction
- **Spec 02:**
  - Google sign-in with `openid-client` and opaque DB sessions, plus logout
  - organization onboarding
  - Gmail OAuth (read-only), with encrypted credentials, refresh, revocation and disconnect
  - 90-day backfill and History API incremental sync, with expiry recovery, lease and cron
  - normalized EmailThread, EmailMessage and Recipient models and NormalizedEmailContext
  - owner-private RLS, a protected API and a minimal UI

### Explicitly out of scope (Spec 03+)

- AI of any kind: reasoning, summaries, scoring
- Opportunity Health, Lead Health and Follow-up detection
- Daily brief
- HubSpot, Calendar and CRM sync
- Email sending and autonomous actions
- Custom responsibility execution
- Gmail Pub/Sub push
- Job queues, workers and Redis
- Team invitations and organization switching
- Slack, Salesforce, Apollo, Clay and LinkedIn
- Outbound automation and billing

## Known limitations

- **Initial backfill runs within a single request.** It's batched and leased,
  but very large mailboxes may exceed serverless time limits. Pagination
  progress isn't checkpointed, so the next run restarts the backfill
  (idempotently) until it completes once.
- **The cron processes up to 10 mailboxes per call, sequentially.** Schedule it
  at a frequency that fits your mailbox count.
- **One organization per user, no invitations.** Sign-in binds the user's
  earliest membership.
- **`send-as` aliases aren't known.** Messages sent from an alias are marked `UNKNOWN`.
- **Only `text/plain` and `text/html` bodies are handled.** Attachments aren't stored.
- **An action stuck in `EXECUTING` after a crash has no recovery path yet.**
  This is inherited from Foundation.
- **Organizations can't be hard-deleted** (the audit log is append-only).
