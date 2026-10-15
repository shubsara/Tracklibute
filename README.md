# Tracklibute

**AI Sales Operations for small B2B teams.**
Core promise: *qualified leads and active opportunities don't go cold.*

Tracklibute owns a small set of sales **Responsibilities**: Lead Health,
Opportunity Health, Follow-up, CRM Hygiene and Meeting Readiness. It watches
Gmail, HubSpot and Google Calendar, raises **Recommendations**, and proposes
**Actions** that a human approves before anything consequential happens.

> **Current stage: Build Spec 01 — Foundation.** This stage has data model,
> tenancy, security boundaries and abstractions only. There are no integrations,
> no AI and no detection logic yet.

---

## Architecture overview

```
 Request ──▶ AuthProvider (dev now; real provider later)
              │  server-signed session → { userId, organizationId }
              ▼
           resolveAuthContext ── re-verifies membership + role in DB every request
              │  AuthContext { userId, organizationId, role }
              ▼
           Services (src/server/*) ── role checks + explicit organizationId filters
              │
              ▼
           withOrgScope(tx) ── SET LOCAL app.organization_id → PostgreSQL RLS
              │
              ▼
           PostgreSQL (runtime role: no superuser, no BYPASSRLS, not owner)
```

Action pipeline (the only way anything leaves Tracklibute):

```
 AI / responsibility / user
        │ proposeAction(type, payload)
        ▼
 ProposedAction (PROPOSED) ──▶ ActionRegistry (closed, typed, strict schemas)
        │                           │
        │                    policy: role, payload, provider connected, executor exists
        ▼
 Approval (immutable) ── required if consequential, enforced by DB triggers
        ▼
 Executor (atomic claim → EXECUTING → EXECUTED | FAILED) ──▶ provider adapter
```

| Layer | Path | Notes |
|---|---|---|
| Domain (pure, no Next/DB) | `src/domain/` | AuthContext and roles, Responsibility templates, action registry and policy, integration contracts |
| Server services | `src/server/` | Auth boundary, org-scoped DB, audit, actions, responsibilities, integrations |
| HTTP | `src/app/api/` | Thin route handlers wrapped by `authedRoute` |
| Schema | `prisma/schema.prisma` | Prisma 7, generated client in `src/generated/prisma` |
| DB guards | `prisma/migrations/*_rls_and_guards/` | RLS, grants, auth lookups, state machine, append-only tables |
| Decisions | `docs/adr/0001-foundation-architecture.md` | Why it's built this way |

### Data model

| Model | Purpose |
|---|---|
| `Organization` | The tenant. One naming concept throughout: Organization. |
| `User` | Global identity. It can belong to many organizations. |
| `OrganizationMember` | User ↔ Organization with role `OWNER` / `ADMIN` / `MEMBER` / `VIEWER` |
| `Integration` | Gmail / HubSpot / Google Calendar connection with encrypted credentials. |
| `Responsibility` | The core abstraction: `SYSTEM` (template) or `CUSTOM`, with typed config. |
| `ResponsibilityRun` | One evaluation of a responsibility. Detectors arrive in later specs. |
| `Recommendation` | A finding raised by a run. |
| `ProposedAction` | A typed action awaiting approval and execution, with a DB-enforced state machine. |
| `Approval` | One immutable human decision per action. |
| `AuditLog` | Append-only event trail. Secrets are redacted. |

There are deliberately **no** contact, deal, email or meeting models yet. They
belong to the normalized sales-context specs.

### Roles

| Capability | VIEWER | MEMBER | ADMIN | OWNER |
|---|:-:|:-:|:-:|:-:|
| Read org data | ✓ | ✓ | ✓ | ✓ |
| Propose / approve / execute actions | | ✓ | ✓ | ✓ |
| Manage responsibilities and integration credentials | | | ✓ | ✓ |

---

## Local setup

**Requirements:** Node ≥ 22.18, pnpm 10 (`corepack enable`), PostgreSQL 16.
Docker is not required.

```bash
pnpm install                       # also runs `prisma generate`
cp .env.example .env               # then fill the two secrets (see below)
```

### PostgreSQL setup

Start your local PostgreSQL 16, then create the two roles and two databases:

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

### Environment variables

| Variable | Required | Description |
|---|:-:|---|
| `DATABASE_URL` | ✓ | Runtime connection as `tracklibute_app` |
| `DATABASE_OWNER_URL` | ✓ (tooling) | Owner connection for migrate, seed and tests. Never used by the app. |
| `CREDENTIALS_ENCRYPTION_KEY` | ✓ | 32 bytes, base64 (`openssl rand -base64 32`) |
| `AUTH_SESSION_SECRET` | ✓ | ≥ 32 chars, signs dev session tokens (`openssl rand -base64 48`) |
| `DEV_AUTH_ENABLED` | | `true` enables dev login. It is always off when `NODE_ENV=production`. |

Tests read `.env.test`: the same keys, pointing at `tracklibute_test`. Create it with
`sed 's/tracklibute_dev/tracklibute_test/g' .env > .env.test`.

### Database migrations

```bash
pnpm db:migrate      # prisma migrate dev: apply + create new migrations (development)
pnpm db:deploy       # prisma migrate deploy: apply pending migrations (CI/production)
pnpm db:reset        # drop and re-create the dev database (destructive)
pnpm db:generate     # regenerate the Prisma client
```

### Seed

```bash
pnpm db:seed         # idempotent
```

The seed creates `acme` (alice@acme.test OWNER, bob@acme.test MEMBER,
vera@acme.test VIEWER) and `globex` (gina@globex.test OWNER). Each gets five
SYSTEM responsibilities, PENDING integrations, one sample recommendation, and
one consequential proposed action awaiting approval.

### Development

```bash
pnpm dev                                   # http://localhost:3000
# Browser: open /dev/login and sign in (e.g. alice@acme.test / acme)
pnpm dev:token alice@acme.test acme        # prints a bearer token for API use
curl localhost:3000/api/health
curl -H "Authorization: Bearer <token>" localhost:3000/api/me
```

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/health` | public | Liveness and database connectivity |
| `GET /api/me` | session | User, organization and role, all server-derived |
| `GET /api/responsibilities` | session | Org-scoped list |
| `POST /api/responsibilities` | ADMIN+ | Create a CUSTOM responsibility |
| `GET /api/integrations` | session | Integration status. Credentials are never included. |
| `POST/DELETE /api/dev/session` | dev only | Dev sign-in/out. Returns 403 in production. |

### Tests and quality gates

```bash
pnpm typecheck       # tsc --noEmit, strict mode
pnpm lint            # eslint, zero warnings allowed
pnpm test            # vitest: unit, tenancy, approval gate, API, integrations
pnpm build           # production build
```

Tests run against `tracklibute_test`. Global setup applies migrations with
`prisma migrate deploy` (non-destructive), and each test creates uniquely named
organizations.

| Suite | Proves |
|---|---|
| `tests/tenancy.test.ts` | Org A cannot read or modify org B responsibilities, recommendations or actions, at both the app layer and the RLS layer. It also checks composite FKs and the runtime role's privileges. |
| `tests/approval-gate.test.ts` | Non-consequential actions run freely. Consequential actions need approval. Rejected or executed actions never run. Concurrent execution runs once. DB triggers block direct SQL bypasses. |
| `tests/api.test.ts` | Health, 401/403 paths, forged tokens, spoofed org IDs ignored, membership re-checked per request, role enforcement |
| `tests/integrations.test.ts` | Credentials are encrypted at rest, admin-only, cross-org unreadable and AAD-bound. DTOs and audit logs carry no secrets. |
| `tests/unit/*` | Cipher, session tokens, registry/policy, responsibility templates |

---

## Security model (Foundation)

- **The auth boundary is `AuthContext`.** Domain and services never see cookies,
  providers or client-supplied IDs.
- **Two independent tenancy layers:** app filters plus role checks, and PostgreSQL
  RLS with composite FKs.
- **Approval is enforced twice:** in the service, and by DB triggers on
  `proposed_actions` and `approvals`.
- **Closed action registry:** the AI can only propose typed actions. It never
  executes them, never holds credentials and never names endpoints.
- **Credentials** are encrypted with AES-256-GCM, with the AAD bound to the org
  and the integration. They are decrypted only server-side, never returned to
  clients and never logged. Audit metadata is redacted by key name.
- **Append-only:** `approvals` and `audit_logs` reject UPDATE and DELETE, even for
  the owner role.

> ⚠️ **This is not production secret management.** `CREDENTIALS_ENCRYPTION_KEY`
> comes from an environment variable. Production must load it from a managed
> secret store or KMS (e.g. GCP Secret Manager, AWS KMS, Doppler) with key
> rotation (the envelope is versioned `v1.` for this). It must also keep
> `DATABASE_OWNER_URL` out of the runtime environment.

Production database (provisional): Neon PostgreSQL. Everything here is standard
PostgreSQL. On Neon, create a `tracklibute_app` role without `BYPASSRLS` before
running `pnpm db:deploy` as the owner.

---

## Scope

### In scope (Foundation, done)

Next.js + TypeScript (strict) + Prisma 7 + PostgreSQL 16 · Organization
multi-tenancy with RLS · auth boundary with a dev provider · roles ·
Responsibility, Run, Recommendation, ProposedAction, Approval and AuditLog
models · closed action registry with placeholder actions · approval gate ·
integration adapter contracts and an encrypted credential vault · health and
protected routes · minimal shell.

### Explicitly out of scope

Gmail, HubSpot or Google Calendar OAuth and ingestion · AI/LLM calls · lead,
opportunity or follow-up detection · CRM hygiene · meeting prep · sending email
· CRM updates · a production auth provider · workflow builder or generic
workflow engine · agent framework or marketplace · outbound sequencing ·
Apollo, Clay or LinkedIn automation · Salesforce · Slack · billing/Stripe ·
arbitrary code execution · polished UI.

## Known limitations

- The dev auth provider has no passwords. It exists only to exercise the
  boundary, and it is hard-disabled in production.
- An action stuck in `EXECUTING` (process crash mid-handler) has no recovery
  path yet. That comes with the first real executor.
- There is no background job runner yet. `ResponsibilityRun` exists as a model only.
- Organizations cannot be hard-deleted (append-only audit). Soft-delete comes later.
