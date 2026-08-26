# Portable architecture

This document records the current implementation boundary for the PostgreSQL
edition. The product target remains full fresh-install feature parity with the
canonical Cloudflare edition and no intentional public HTTP or frontend
contract changes.

## Runtime topology

The application image exposes four commands:

| Command | Responsibility |
|---|---|
| `server.js` | Hono API, health endpoints, and React SPA |
| `worker.js` | Graphile Worker tasks and persistent schedules |
| `migrate.js` | Belki SQL migrations followed by the Graphile schema migration |
| `admin.js` | Bounded operational commands |

Caddy is the only public Compose service. Web, worker, PostgreSQL, object
storage, SMTP, and OIDC processes communicate on an internal network.

## Adapter boundary

Portable code depends on the interfaces in `src/portable/contracts.ts`:

- `Database`
- `JobDispatcher`
- `ObjectStore`
- `StructuredInferenceClient`
- `EmailSender`
- `OperatorIdentity`

The initial concrete implementations are PostgreSQL/`pg`, Graphile Worker,
AWS SDK S3, OpenAI-compatible chat completions with strict JSON Schema, SMTP,
and trusted oauth2-proxy headers.

## Persistence

`migrations/postgres` is the forward migration source. The migrations currently
contain installation/auth, usage-gate, project/brand/source, and scheduled
prompt/tag tables required by the implemented UI contracts. Native PostgreSQL
types are used:

- UUID identifiers
- `boolean` feature flags
- `timestamptz` timestamps
- `jsonb` metadata

Usage reservations are serialized with
`pg_advisory_xact_lock(hashtextextended('belki:usage:' || workspace_id, 0))`.
Reservation IDs and resource claim IDs are durable idempotency keys. Active
project/prompt resources also have a partial unique index, preventing a second
claim under another request ID.

Snapshot/control consolidation is not complete. The existing D1 migrations in
`migrations/control` and `migrations/snapshot` remain reference inputs until
each query family has a PostgreSQL repository and integration tests.

## Authentication and managed identity

Local password sessions retain the canonical cookie names, CSRF behavior,
PBKDF2 parameters, roles, workspace selection model, and public setup/status
contract.

Managed operator identity uses two headers:

- `X-Auth-Request-Email` from oauth2-proxy
- `X-Belki-Proxy-Secret` from the private Caddy-to-web hop

The application rejects an identity header without the matching trust secret.
Base and local Caddy configurations remove both headers from public requests.

## Health model

Liveness has no dependency checks. Readiness covers:

- PostgreSQL connectivity
- application migration presence
- Graphile Worker schema presence
- object storage bucket access
- inference mode/configuration
- SMTP mode/connectivity
- Stripe mode/configuration
- operator identity mode/configuration

Disabled optional capabilities report healthy with their disabled mode rather
than pretending to be configured.

## Source synchronization

Only paths in `upstream-sync.json` are mirrored. The current record is stored in
`UPSTREAM.json`. The checker compares file sets and contents, then validates the
source commit, combined tree checksum, and file count.

Portable runtime code must never be added to the allowlist. When a canonical
file still mixes pure logic with Cloudflare APIs, first refactor the pure logic
in the canonical repository, retain its Cloudflare behavior, then add only the
new pure path to the allowlist.

## Completed slices

1. Node build/runtime and validated environment.
2. Service interfaces and initial adapters.
3. PostgreSQL migration runner and Graphile Worker schema.
4. Fresh bootstrap plus login/session/logout.
5. Transactional usage reservations and resource claims.
6. Health/readiness behavior.
7. OCI image and Compose topology.
8. Allowlisted upstream synchronization.
9. Workspace/project CRUD, tracked brands, and tracking-source settings.
10. First-project onboarding, scheduled prompt CRUD, prompt tags, and the
    pre-capture prompt-list read model.

## Next slices

Implement in contract-preserving vertical slices, each with PostgreSQL
integration tests:

1. Graphile scheduling/enqueueing for due and manual prompt runs.
2. DataForSEO submission/postback, S3 evidence writes, normalization, and
   snapshot tables.
3. Rollups, analytics read models, and cursor-heavy report queries.
4. Alerts, notifications, exports, purge, enrichment, entity extraction, and
   ad assets.
5. Invitations/password reset over SMTP.
6. Stripe persistence/webhooks and managed operator routes.
7. Full end-to-end and modeled one-million-runs/month load tests.

No slice is complete until retry, idempotency, cross-workspace isolation, and
restart recovery behavior is covered where applicable.
