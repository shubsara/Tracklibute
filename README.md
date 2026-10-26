# Tracklibute

**AI Sales Operations for small B2B teams.**
Core promise: *qualified leads and active opportunities don't go cold.*

Tracklibute owns a small set of sales **Responsibilities**: Lead Health,
Opportunity Health, Follow-up, CRM Hygiene and Meeting Readiness. It watches
Gmail, HubSpot and Google Calendar, raises **Recommendations**, and proposes
**Actions** that a human approves before anything consequential happens.

> **Current stage: Spec 05 — Lead Health.** Tracklibute has a read-only HubSpot
> mirror, content-free organization-readable EmailActivity, and deterministic
> Opportunity Health. Spec 05 adds qualification-aware Lead Health for standalone
> contacts. There is no AI scoring, no CRM writes, and no email sending.

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
| `GMAIL_QUOTA_UNITS_PER_SECOND` | | Gmail quota pacing per mailbox (default **80**; Google allows 100/s) |
| `GMAIL_SYNC_RUN_BUDGET_SECONDS` | | Max seconds per sync run before ending as *partial* (default **210**) |
| `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET` | for HubSpot | HubSpot app (OAuth) credentials. Without them HubSpot returns 503 "not configured". |
| `HUBSPOT_REDIRECT_URI` | for HubSpot | Must exactly match the app's redirect URL (`…/api/integrations/hubspot/callback`) |
| `HUBSPOT_REQUESTS_PER_10S` | | Client-side pacing (default **90**; HubSpot allows 110 / 10 s per installed app) |
| `HUBSPOT_SYNC_RUN_BUDGET_SECONDS` | | Max seconds per HubSpot sync run before ending as *partial* (default **240**) |
| `CRON_SECRET` | for cron | ≥ 32 chars. Bearer secret for `/api/internal/cron/hubspot-sync` and `/api/internal/cron/opportunity-health` |
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

Tests run against `tracklibute_test` and never call real Google or HubSpot.
`tests/support/fake-google.ts` is an in-process fake of Google's OIDC discovery,
JWKS, token and revoke endpoints and the Gmail REST API, with failure injection.
`tests/support/fake-hubspot.ts` fakes the HubSpot OAuth 2026-03 and CRM read
endpoints Tracklibute uses, records every request, and is used to prove that no
write request is ever sent. There is no CI configured yet: run these gates locally.

| Suite | Proves |
|---|---|
| `auth-session` | Sign-in, onboarding to OWNER, server-derived org, logout revokes, hashed tokens, CSRF, dev auth off in production |
| `gmail-oauth` | Read-only PKCE auth URL, state/CSRF, session binding, scope enforcement, encrypted credentials, disconnect, revoked → reauth |
| `gmail-adapter` | Listing, message, thread, history, parsing, MIME, retries/rate limits, token refresh, typed errors |
| `gmail-sync` | 90-day and custom lookback, batching, incremental history, deletions, idempotency, failure keeps cursor, history-expiry recovery, concurrency lease |
| `gmail-sync-resume` | Pacing under the emulated 6,000-units/min quota (zero 429s), exponential backoff recovery, partial vs failed outcomes, resume without re-fetch, original-checkpoint correctness across runs, deadline time-box, sibling cancellation, diagnostics |
| `email-isolation` | Org A vs B **and** member vs member in one org, at app and RLS layers. URL/body tampering, composite FKs, cron secret, member removal. |
| `security` | No tokens, codes or bodies in responses, logs or audit. RLS on every table. Composite FKs. Email content triggers nothing. |
| `hubspot-oauth` | Read-only scopes, OAuth 2026-03 token + introspection, secrets never in URLs, user-level / foreign-client / write-scope grants refused, refresh, reauth, disconnect |
| `hubspot-sync` | Full and incremental sync, 10k search re-anchor, archiving, resume, rate limits, Pipelines 2026-09 and its UNAVAILABLE fallback, zero write requests |
| `crm-isolation` | RLS on every CRM table, cross-tenant writes refused, owner-mapping authorization |
| `email-activity` | Content-free derivation, eligibility rules, rebuild, member-readable but owner-writable rows |
| `opportunity-health` | Deterministic states and reasons, dedupe, recommendation lifecycle, limited signal, unknown-status deals skipped |
| `responsibility-install` | Onboarding installs SYSTEM responsibilities, idempotent repair route, post-sync health failures logged and surfaced |
| `deal-detail-recommendations` | Open vs resolved recommendations on the deal detail page |
| Foundation suites | Tenancy, approval gate, API, integrations, units |

---

## Gmail sync behavior

Google's limits (Usage limits page, updated 2026-09-10):

- **Per-user quota:** 6,000 units per minute.
- **`messages.get` costs 20 units.** A mailbox can therefore fetch at most
  about **300 messages per minute**.
- **The sync is designed around that ceiling.** A large initial backfill
  spans several runs.

- **Pacing:** a shared quota pacer spends at most `GMAIL_QUOTA_UNITS_PER_SECOND`
  per run (default **80 units/s**, about 4 messages/s and 240/minute) with
  **2** concurrent workers.
- **Backoff:** rate limits (429, or a rate-limit 403) back off exponentially:
  1, 2, 4, 8, 16 s, capped at 32 s, plus up to 1 s of jitter, for up to 5
  retries. `Retry-After` is honoured, and the pacer pauses so **every** worker
  waits. 5xx errors get a short backoff with 3 retries. When one worker fails
  fatally, sibling workers stop and in-flight calls settle before the run ends.
- **Time-boxed runs:** each run gets `GMAIL_SYNC_RUN_BUDGET_SECONDS` (default
  **210 s**). Workers stop picking up messages at the deadline. The cron
  shares one 250 s budget across mailboxes.
- **Resumable initial backfill:**
  - It covers messages newer than `GMAIL_SYNC_LOOKBACK_DAYS` (default 90).
  - On the first run, the mailbox `historyId` is stored as `backfill_cursor`.
  - Every run skips messages already stored, so re-runs **resume** rather
    than restart.
  - When the backfill completes, `sync_cursor` ← `backfill_cursor`, the
    checkpoint from when the backfill *started*. Deletions and label changes
    made during a multi-run backfill are then replayed by the first
    incremental sync.
- **Partial vs failed runs:**

  | Outcome | Cause | Effect |
  |---|---|---|
  | **Partial** | The budget ran out | Lease released, no error recorded. UI shows "initial sync in progress (continues automatically)", audit `gmail.sync_partial`. |
  | **Failed** | Rate-limit retries exhausted, Gmail unavailable, or access revoked | `lastError` and `gmail.sync_failed` recorded. Stored progress and `backfill_cursor` are kept, so the next run resumes. |

- **Incremental sync:** Gmail History API since `sync_cursor`. Added or
  relabelled messages are re-fetched. Deleted, trashed or spammed messages are
  removed, and empty threads are dropped. If a run is time-boxed, the cursor
  isn't advanced and the next run replays the changes idempotently.
- **Checkpoint safety:** `sync_cursor` is committed only by a **complete** run
  that still holds its lease (compare-and-set). All writes are idempotent:
  - messages: unique `(integrationId, externalMessageId)`
  - threads: unique `(integrationId, externalThreadId)`
- **Expired history:** if Gmail returns 404 for the cursor, Tracklibute:
  - records `gmail.resync_required`
  - clears both cursors
  - starts a bounded recovery backfill, which can itself span runs

  A failed incremental sync is never reported as a success.
- **Concurrency:** a single-row lease (`syncLeaseExpiresAt`, 10 min, extended
  per batch) admits one run per mailbox. A crashed run's lease expires and is
  reclaimable.
- **Diagnostics:** rate-limit retries and failures log the Gmail `endpoint`,
  `httpStatus` and Google's `providerReason`. These are non-secret and never
  include tokens or content.
- **Tokens:**
  - Access tokens refresh 60 s before expiry; a 401 forces one refresh.
  - If Google rejects the refresh (`invalid_grant`), the integration becomes
    `REAUTH_REQUIRED`. The row and data are kept.
- **Not ingested:** drafts, spam, trash and chat. Only allow-listed system
  labels and headers are stored.
- **Bodies:** `text/plain` is preferred, with HTML converted to plain text as a
  fallback. Whitespace is normalized and the body is capped at **50,000 chars**.
  There's no AI and no summarization.

---

## HubSpot, EmailActivity and Opportunity Health (Spec 03)

### HubSpot (read-only)

- **One org-wide integration**, connected and disconnected by an ADMIN/OWNER.
  A partial unique index allows only one org-wide row per provider.
- **Scopes requested** (read only): `oauth`, `crm.objects.deals.read`,
  `crm.objects.contacts.read`, `crm.objects.companies.read`,
  `crm.objects.owners.read`. A grant carrying any write scope is refused.
- **HubSpot app setup:** create an **account-level** HubSpot OAuth app (not
  user-level: `isUserLevel` must be false or unset) with exactly these scopes
  and the redirect URL `…/api/integrations/hubspot/callback`. HubSpot
  documents that user-level apps can't use several APIs the sync needs (owners,
  association batch reads, v3 objects/search), so Tracklibute refuses tokens
  whose introspection reports `isUserLevel: true`.
- **OAuth endpoints (date-versioned 2026-03):** `POST /oauth/2026-03/token`
  handles both the code exchange and refresh. `POST
  /oauth/2026-03/token/introspect` checks that the token is active, is an access
  token, was issued to our client ID, names a portal, and grants exactly the
  read scopes. Every credential travels in a form body, never in a URL. The
  deprecated v1 endpoints are no longer used or reachable.
- **No write path exists.** Every HubSpot request passes a closed
  (method, path) allow-list in `hubspot.client.ts`. The only POSTs are the
  OAuth token exchange and introspection, plus read-only queries (search,
  batch read). The `hubspot.*` actions stay in the registry without an executor.
- **Sync:**
  - Owners and deal pipeline stages are refreshed on every run. Stages come
    from `GET /crm/pipelines/2026-09/deals`.
  - **Pipelines unavailable:** if HubSpot refuses pipeline reads (403 without
    `MISSING_SCOPES`, 404) or returns an unusable shape, the run continues.
    The integration shows pipeline metadata as `UNAVAILABLE`, with a safe
    reason. The last stage metadata HubSpot actually returned is kept, and
    nothing is invented.
  - **Open/closed classification:** a deal's open/closed status comes from its
    stage's `isClosed`. If the stage doesn't state it, HubSpot's calculated
    `hs_is_closed` is used. Otherwise the status is stored as **unknown**.
    Unknown-status deals are never evaluated by Opportunity Health, and their
    recommendations are left untouched.
  - A **full reconcile** (deals list with embedded associations) runs on first
    connect and every 24 h. It is resumable, and deals not seen in a
    *complete* pass are archived.
  - Between full passes, an **incremental** search on
    `hs_lastmodifieddate ≥ watermark` runs, oldest first. Associations come from
    v4 batch reads. At HubSpot's 10,000-result search window, the query
    re-anchors at the newest timestamp seen.
  - Deal-associated contacts and companies are fetched for relationship mapping.
  - Lead Health's full reconcile also lists every contact, including standalone
    contacts not yet associated with a deal, so qualification and activity can
    be evaluated before an opportunity exists. Contact changes are refreshed on
    the next complete contact reconcile (at most every 24 h), while email activity
    is re-evaluated after Gmail sync.
- **Limits:**
  - 90 requests per 10 s client-side, plus 4/s for search.
  - Adaptive waits use `X-HubSpot-RateLimit-*` headers; 429s honour
    `Retry-After`.
  - A run stops as *partial* when less than 5% of the daily allowance remains.
- **Lease, budget and checkpoints** follow the Gmail pattern. A revoked grant
  (refresh `400/401`, or `403 MISSING_SCOPES`) sets `REAUTH_REQUIRED`.
- **Disconnect** wipes the credentials and the CRM mirror and resolves its
  recommendations. Nothing is sent to HubSpot; remove the app in HubSpot's
  *Connected apps* to revoke it there.
- **Owner mapping:** a HubSpot owner is auto-mapped to the member with the same
  email (`AUTO_EMAIL`). An admin can override it (`MANUAL`), and sync never
  overwrites a manual mapping. Mappings feed "mine" filters and the
  limited-signal flag.

### EmailActivity (content-free, organization-readable)

- **What it is:** a derived layer written by each mailbox owner's Gmail sync,
  in the same transaction as the message.
- **Columns:** organization, mailbox user, integration, opaque Gmail
  message/thread ids, direction, counterpart email/domain, and timestamp.
  **No subject, snippet, body, labels or names.** This is enforced by the schema
  and tested via `information_schema`.
- **Eligible messages:** INBOUND or OUTBOUND, not bulk or automated (List-Id,
  List-Unsubscribe, Precedence, Auto-Submitted), with at least one external
  counterpart. Outbound uses To + Cc; Bcc is never used. Inbound uses the sender.
- **Internal addresses are never counterparts:** the mailbox itself, members'
  emails, the mailbox's own domain (unless it is a public provider), and the
  admin-configured internal domains (`/settings/organization`).
- **Access:** any member can SELECT. INSERT and DELETE are limited to the mailbox
  owner by RLS. There is no UPDATE grant. Owner-private email tables are
  unchanged.
- **Rebuilds:** existing mailboxes are backfilled, and rule changes re-derived,
  from locally stored mail on the next sync, with zero Gmail API calls.

### Opportunity Health (deterministic)

- **Data sources:** HubSpot plus EmailActivity only. No Calendar, no AI, no score.
  Every open deal is **HEALTHY**, **NEEDS_ATTENTION** or **AT_RISK**.
- **Reasons and thresholds:**

  | Reason | Rule | State |
  |---|---|---|
  | `PAST_CLOSE_DATE` | close date before today | AT_RISK |
  | `INACTIVE` | no email/CRM activity > `inactiveAfterDays` (7) | NEEDS_ATTENTION |
  | `INACTIVE` (escalated) | > 2× threshold, or never any activity on an older deal | AT_RISK |
  | `AWAITING_OUR_REPLY` | buyer wrote last, unanswered > `awaitingReplyAfterDays` (2) | NEEDS_ATTENTION |
  | `AWAITING_OUR_REPLY` (escalated) | unanswered > `inactiveAfterDays` | AT_RISK |
  | `AWAITING_BUYER_REPLY` | salesperson wrote last, unanswered > `awaitingReplyAfterDays` (2) | NEEDS_ATTENTION |
  | `AWAITING_BUYER_REPLY` (escalated) | unanswered > `inactiveAfterDays` (7) | AT_RISK |
  | `NO_NEXT_ACTIVITY` | nothing scheduled in HubSpot | NEEDS_ATTENTION |
  | `UNTRACKABLE` | no contact email / company domain to match | NEEDS_ATTENTION |

- **Reply rules:** `AWAITING_OUR_REPLY` and `AWAITING_BUYER_REPLY` use the
  latest matched inbound/outbound timestamps and the same 2-day / 7-day
  thresholds. A scheduled CRM task does not suppress an unanswered-email reason.
  Because `EmailActivity` is content-free, the MVP cannot infer whether a
  specific outbound email explicitly requested a reply; any matched one-to-one
  outbound email is treated as awaiting a response until a later inbound email
  appears. Replies outside connected Gmail or unmatched contacts/domains may not
  clear this signal.
- **Out of scope here:** missing CRM fields (e.g. close date) belong to the
  future CRM Hygiene responsibility.
- **Evidence** is metadata only (dates, counts, ids, reason codes). It is
  validated against a strict allow-list before it is stored.
- **Limited signal:** if the deal owner is unmapped or has no connected Gmail,
  the deal is flagged *limited signal*, so a "gone quiet" result there may be a
  false alarm.
- **Recommendations:** one per deal, forever (`dedupe_key`). Each run creates,
  refreshes in place, reopens or resolves it:
  - Snoozed items reopen when the snooze expires.
  - Dismissed or accepted items reopen only if the deal gets worse.
  - Resolved items reopen as a new episode.
  - Snooze, dismiss and accept go through the action registry as internal,
    non-consequential actions.
- **Installation:** onboarding installs every SYSTEM responsibility,
  including Opportunity Health. Organizations created before that fix can be
  repaired by an ADMIN with `POST /api/responsibilities/system` (optionally
  `{"runOpportunityHealth": true}`), or with the *Install default
  responsibilities* button on Settings → Integrations. The repair is
  idempotent and doesn't touch existing responsibilities, connections or data.
- **Post-sync failures are visible:** a health run that fails after a
  completed HubSpot sync is logged (`opportunity_health.post_sync_failed`),
  audited, and shown on the HubSpot card until a later run succeeds. It is
  never silently swallowed.
- **When it runs:** after each completed HubSpot sync, on
  `POST /api/internal/cron/opportunity-health`, or manually by an ADMIN. Only
  one run per organization can be active (DB partial unique index); stale runs
  are failed after 15 minutes.

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
- **CRM and EmailActivity:** organization-isolated by RLS on every new table.
  EmailActivity is the only email-derived data other members can read, and it
  has no content columns.
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

### Lead Health (Spec 05 — in progress)

- **Purpose:** identify qualified standalone contacts that haven't received a
  timely first touch, are inactive, or are waiting on a response.
- **Contact mirror:** full reconciliation fetches all non-archived HubSpot
  contacts, including those not associated with a deal. Qualification, lifecycle,
  owner, contact/activity timestamps and qualification-stage timestamps are
  mirrored; stale records are archived only after the complete contact pass. A
  legacy v1 sync cursor forces one full reconcile so existing portals populate
  the new contact fields before returning to incremental sync.
- **Qualification:** Sales Qualified Lead is included by default. Marketing
  Qualified Lead is optional. Customers and contacts explicitly marked
  Unqualified or Bad Timing are excluded. Any associated active or unknown-status
  deal suppresses pre-opportunity Lead Health to avoid duplicate alerts. A contact with only a known closed-lost deal remains eligible as a reactivation candidate, even if HubSpot advanced its lifecycle stage to Opportunity.
- **Rules:** no first touch after more than 1 business day → NEEDS_ATTENTION;
  no first touch after more than 3 business days → AT_RISK. General inactivity
  after more than 3 business days → NEEDS_ATTENTION and more than 5 → AT_RISK.
  Reply-direction alerts use more than 2 business days and escalate after more
  than 7 calendar days. A future planned activity suppresses general inactivity,
  but not an overdue direction-specific reply alert.
- **Evidence:** exact contact email matches drive reply direction. Activity from
  the same business email domain is context only; it doesn't reset the contact's
  individual inactivity clock. No email content is copied into shared evidence.
  Missing qualification timestamps never trigger guessed first-touch deadlines. Business-day counting currently uses the UTC weekday calendar because organization time zones are not configurable yet.
- **Lifecycle:** one deduplicated recommendation per contact; recommendation
  resolves when the lead is healthy or no longer eligible. Leads without an
  email address aren't classified as cold. An unmapped contact owner or one without a connected Gmail mailbox is
  recorded as limited signal, not hidden.
- **Boundaries:** HubSpot remains read-only. No CRM writes, AI scoring, or email
  sending. Defaults need validation with the developer test portal before merge.

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
- **Spec 03:**
  - read-only HubSpot OAuth and sync (deals, contacts, companies, owners, stages)
  - owner → member mapping
  - the content-free EmailActivity layer
  - deterministic Opportunity Health
  - recommendation deduplication and lifecycle
  - opportunities, recommendations and settings UI

### Still out of scope for the current MVP

- AI of any kind: reasoning, summaries, scoring
- Follow-up, CRM Hygiene and Meeting Readiness detection
- Daily brief
- Any CRM write (tasks, stage updates, notes, properties); HubSpot webhooks
- Google Calendar
- Email sending and autonomous actions
- Custom responsibility execution
- Gmail Pub/Sub push
- Job queues, workers and Redis
- Team invitations and organization switching
- Slack, Salesforce, Apollo, Clay and LinkedIn
- Outbound automation and billing

## Known limitations

- **Initial backfill throughput is bounded by Google's quota.** It runs at
  about 240 messages per minute per mailbox. A mailbox with 3,000 messages in
  90 days needs about 13 minutes of sync time, spread over several runs (cron
  or Sync now).
- **Resumed runs re-list pages.** Each page costs 5 units, and stored messages
  are skipped, not re-fetched.
- **Messages already stored by an earlier backfill run aren't re-fetched**
  before the backfill completes. Their label changes are applied by the first
  incremental sync.
- **The cron processes up to 10 mailboxes per call, sequentially, within one
  250 s budget.** Schedule it often enough for your mailbox count; mailboxes it
  doesn't reach stay eligible.
- **Gmail 403s are classified by Google's reason code:**
  - `accessNotConfigured` / `SERVICE_DISABLED` → *API disabled*. The
    integration stays CONNECTED, the error tells an admin to enable the Gmail
    API, and sync resumes once it's enabled.
  - `insufficientPermissions` / `ACCESS_TOKEN_SCOPE_INSUFFICIENT` →
    *reconnect required*.
  - Any other 403 → *access denied*: stays CONNECTED and is retried later.
  - Only a revoked or invalid grant, a persistent 401, or a missing scope sets
    `REAUTH_REQUIRED`.
- **One organization per user, no invitations.** Sign-in binds the user's
  earliest membership.
- **`send-as` aliases aren't known.** Messages sent from an alias are marked `UNKNOWN`.
- **Only `text/plain` and `text/html` bodies are handled.** Attachments aren't stored.
- **An action stuck in `EXECUTING` after a crash has no recovery path yet.**
  This is inherited from Foundation.
- **Organizations can't be hard-deleted** (the audit log is append-only).
- **HubSpot association changes** that don't bump a deal's
  `hs_lastmodifieddate` are picked up by the daily full reconcile, up to 24 h later.
- **HubSpot list associations** are taken as embedded in the deals list. A deal
  with more associations than HubSpot embeds per record may be incomplete
  until an incremental update fetches them via v4.
- **HubSpot verification so far — developer test portal only.** On a
  HubSpot *developer test portal* (portal `247756835`, one deal), the
  following was checked manually end to end:
  - OAuth connection (2026-03 token + introspection) succeeded.
  - The deal synced, and an associated contact appeared in Tracklibute.
  - Opportunity Health flagged the deal while no next activity was scheduled.
  - After a next activity was scheduled in HubSpot and synced, the deal became
    Healthy and its recommendation moved from Open to Resolved.
  - The deal detail page no longer shows the resolved recommendation as an
    active issue.

  This is **not** a production-customer validation. These were not exercised
  against real HubSpot and are covered only by the in-process fake (`tests/support/fake-hubspot.ts`):
  - volume (many deals, owners or pipelines)
  - the 10,000-result search re-anchor, rate-limit and daily-allowance handling
  - the pipelines-unavailable degraded state
  - user-level app refusal, and reauth after uninstall or revocation
  - long-running token refresh
  - email-activity matching between a real Gmail mailbox and HubSpot contacts
- **Other CRM reads still use v3/v4 paths** (`/crm/v3/objects/*`,
  `/crm/v3/owners`, `/crm/v4/associations/*`). They are documented and
  supported for account-level apps, but HubSpot now lists them under its
  *legacy* API family.
- **Clearing an owner mapping** lets sync re-create an AUTO mapping if the
  emails still match.
- **The opportunity detector counts only connected mailboxes.** That is why
  limited signal is surfaced, not hidden.
