# ADR 0001 — Foundation architecture

- **Status:** Accepted
- **Date:** 2026-10-15
- **Scope:** Build Spec 01 — Foundation

## Context

Tracklibute is AI Sales Operations for small B2B teams. Its single promise is
that qualified leads and active opportunities don't go cold. The MVP reads
Gmail, HubSpot and Google Calendar, and proposes actions that people approve.
The foundation has to make that promise safe to deliver for many teams on one
deployment, and hard to dilute into a generic automation tool.

## Decisions

### 1. Responsibilities instead of generic workflows

The core abstraction is a **Responsibility**: an ongoing duty Tracklibute owns
for a team ("no qualified lead waits more than 24h for first touch").

- **SYSTEM** responsibilities come from templates in code: Lead Health,
  Opportunity Health, Follow-up, CRM Hygiene and Meeting Readiness. Their
  behaviour is product code. Organizations tune only **typed, bounded,
  flat parameters**, validated by strict Zod schemas.
- **CUSTOM** responsibilities have a name, a description and a narrow typed
  config (`focus`, `reviewEveryDays`).
- There are no triggers, conditions, step lists, visual graphs or a
  workflow engine. Configs that look like workflows are rejected, and tests
  assert this.

*Why:* small teams buy outcomes, not automation tooling. Generic workflow
builders lead to configuration burden, support load and competition with
Zapier/HubSpot Workflows. Owning the logic means we can improve detection
for every customer at once.

### 2. Human approval for consequential actions

An action is **consequential** if people outside the user can see it, or if it
is hard to reverse. Examples: sending email, writing to the shared CRM, inviting
attendees. A consequential action can only run after an **Approval** record with
decision `APPROVED` exists.

- An Approval is a first-class, immutable row: one decision per action. It
  cannot be updated or deleted.
- The `ProposedAction` state machine is **enforced by PostgreSQL triggers**:
  - Entering `APPROVED` or `EXECUTING` without the required approval raises an error.
  - Terminal states (`REJECTED`, `EXECUTED`, `FAILED`, `CANCELLED`) are frozen.
  - `requires_approval`, `payload` and `action_type` are immutable.
  - Rows can only be inserted as `PROPOSED`.
- Execution claims the row atomically with a conditional `UPDATE` to
  `EXECUTING`, so concurrent attempts run the handler at most once.

*Why:* sending the wrong email to a prospect destroys trust faster than any
time saved. The rule therefore holds even if application code has a bug.

### 3. Application tenant isolation + PostgreSQL RLS

The tenant is an **Organization**, and every tenant-owned row has
`organization_id`. There are two independent layers:

1. **Application.** The server derives `AuthContext {userId, organizationId, role}`
   from a server-signed session and re-checks database membership on every
   request. Services filter every query by `auth.organizationId` and check roles.
   IDs supplied by the client are ignored.
2. **Database.** The app connects as `tracklibute_app`. That role is not a
   superuser, has no `BYPASSRLS` and is not the table owner. RLS policies match
   `organization_id = current_setting('app.organization_id')`, which is set
   per transaction by `withOrgScope`. With no context, a query sees zero rows.
   **Composite foreign keys** `(organization_id, id)` stop an org-A row from
   referencing an org-B row. Plain FK checks bypass RLS, so this layer is needed.

The only RLS bypass is two narrow `SECURITY DEFINER` lookup functions. They
resolve membership during authentication, before any org context exists.

*Why:* RLS is the safety net, not the authorization model. It does not know
about roles, approvals or business rules. A cross-tenant leak is fatal at our
stage, so we pay for both layers.

### 4. Closed action registry

Every side effect Tracklibute can perform is one typed entry in
`src/domain/actions/registry.ts`. Each entry has a type, a provider, a
capability, a `consequential` flag, a minimum role and a strict payload schema.

- Unknown types are rejected, and prototype keys are guarded.
- Payloads are validated strictly, so extra fields such as a smuggled
  `endpoint` are refused.
- `requiresApproval` is copied from the registry. The proposer never chooses it.
- There is no "HTTP request", "run script" or webhook action, and a test
  asserts none exists.
- Executors are registered per action type. A type without an executor is
  refused **before** any state change.

### 5. The LLM cannot directly execute APIs

The model's only output channel is `proposeAction(...)`. That call produces a
validated `ProposedAction` row and nothing else. From there it goes through
registry validation, policy checks, approval when consequential, and finally an
executor that calls a provider adapter. The model never holds credentials,
never names endpoints and never calls adapters. Credentials are AES-256-GCM
encrypted and bound to their organization and integration via AAD. They are
decrypted only server-side, at execution time.

## Consequences

- Adding a provider means adding an adapter, registry entries and executors.
  The domain model doesn't change.
- Adding a capability means adding a registry entry. This is deliberate
  friction.
- Organizations are not hard-deleted, because audit logs are append-only even
  for the schema owner.
- Production must hold the database owner credentials apart from the runtime
  role, and must source the encryption key from a managed secret store.
