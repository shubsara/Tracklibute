# ADR 0003 — Content-free EmailActivity, read-only HubSpot, deterministic Opportunity Health

Status: accepted (Build Spec 03)

## Context

Opportunity Health is an organization-level duty: a deal owned by one rep is
watched by the whole team. Spec 02 made synced email strictly owner-private
(RLS on `mailbox_user_id`). The detector therefore cannot read email tables
when it runs on behalf of the organization, and its evidence must not leak
one member's mail to another.

## Decision

1. **EmailActivity, a derived layer with no content.** Each mailbox owner's
   sync writes, in the same transaction as the message, rows that hold only:
   organization, mailbox user, integration, opaque Gmail message/thread ids,
   direction, counterpart email/domain, and timestamp.
   - **Eligibility.** Only INBOUND/OUTBOUND, non-bulk messages produce rows.
     Each row's counterpart is external: outbound uses To + Cc (never Bcc),
     inbound uses the sender. Internal addresses produce nothing.
   - **Access (RLS).** SELECT is allowed at organization level. INSERT and
     DELETE require `mailbox_user_id = app_current_user_id()`. There is no
     UPDATE grant.
   - **The opaque message id** is the idempotency and deletion key. It is
     approved as non-content.
2. **Metadata-only evidence.** Opportunity Health evidence is a strict Zod
   allow-list of dates, counts, ids and reason codes, validated before it is
   persisted.
3. **HubSpot is read-only.**
   - Read scopes only; grants carrying write scopes are refused.
   - A closed (method, path) allow-list rejects anything else before the network.
   - No executor exists for `hubspot.*` actions.
   - Disconnect makes no HubSpot call.
4. **Deterministic health, no score.** HEALTHY / NEEDS_ATTENTION / AT_RISK
   from fixed reason codes. Missing CRM fields belong to CRM Hygiene.
5. **Calendar deferred.** CRM-logged activity (`notes_last_updated`) covers
   meetings in the meantime.
6. **Recommendation deduplication.**
   - `(organization, responsibility, dedupe_key)` is unique, with exactly one
     row per deal.
   - A pure lifecycle function decides create / refresh / reopen / resolve.
   - Dismissed or accepted items reopen only on escalation.
7. **No job engine.**
   - Two cron endpoints and two narrow `SECURITY DEFINER` candidate functions.
   - Per-integration leases, and a partial unique index allowing one active
     responsibility run.
8. **Owner mapping.** HubSpot owners map to members (auto by email, manual
   override). A deal whose owner has no connected Gmail is flagged
   *limited signal*.

## Consequences

- **Teammates can see metadata.** Members can see that a teammate exchanged
  mail with an external address at a time — but never what was said. This
  disclosure was approved explicitly.
- **Rule changes rebuild from local data.** Changing internal domains rebuilds
  each mailbox's activity from local data on its next sync, with no provider
  calls.
- **Signal is incomplete until mailboxes connect.** Detector precision depends
  on mailbox coverage, so limited signal is surfaced in the UI and evidence.

## Amendment (HubSpot API compatibility, before real-portal testing)

- **OAuth uses the date-versioned 2026-03 endpoints.**
  - `POST /oauth/2026-03/token` and `POST /oauth/2026-03/token/introspect`
    replace v1. v1 is deprecated, with sunset on Feb 16, 2027; it put tokens
    in URL paths.
  - Introspection must report an active access token issued to our client ID,
    for a numeric portal, with exactly the read scopes.
  - **User-level apps are refused:** HubSpot's user-level API support excludes
    owners, association bulk reads and the v3 object/search endpoints the sync
    relies on.
- **Deal stages come from `GET /crm/pipelines/2026-09/deals`.**
  - That endpoint accepts `crm.objects.deals.read`, among others.
  - The Pipelines V1 sunset (Dec 4, 2026) concerns `/crm-pipelines/v1/…`, not
    the v3 path we used; we still moved to the current version.
- **Pipelines unavailable is an explicit state.**
  - The integration's `pipeline_metadata_status` is set to `UNAVAILABLE`.
    Stage closed-ness is never guessed.
  - A deal with no usable stage metadata and no `hs_is_closed` has
    `is_closed = NULL`. Opportunity Health skips it instead of judging it.
