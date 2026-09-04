<p align="center">
  <img src="belki-logo.svg" alt="Belki logo" width="96" height="87">
</p>

<h1 align="center">Belki Portable</h1>

<p align="center">
  <strong>The container-first PostgreSQL edition of Belki.</strong>
</p>

Belki Portable is the platform-neutral backend port of
[Belki](https://github.com/GetBelki/belki). The canonical Belki repository
remains Cloudflare-native; this repository replaces D1, R2, Queues, Durable
Objects, Workers AI, Email Sending, and Cloudflare Access with portable Node.js
and open service interfaces while preserving the React UI and public HTTP
contracts.

> [!IMPORTANT]
> The port is under active development. The runtime foundation, fresh
> PostgreSQL bootstrap, local authentication/session flow, usage gate, health
> checks, adapters, image build, Compose topology, and the first-project
> onboarding flow are implemented. Capture execution, most analytics,
> webhooks, billing, and background task routes are not yet at full parity. Do
> not treat this snapshot as a production release.

## Implemented foundation

- Hono on Node.js, serving the built React SPA and `/api/v1` from one image.
- PostgreSQL 16+ through `pg`, with forward-only `node-pg-migrate` migrations.
- Bootstrap, login, session, logout, CSRF, and rate-limit behavior under the
  existing frontend contracts.
- Workspace/project settings, tracked brands, source selection, scheduled
  prompt CRUD, prompt tags, and the prompt-list read contract needed by the
  existing two-step onboarding UI.
- Transactional usage reservations and idempotent project/prompt claims using
  per-workspace PostgreSQL advisory locks.
- Graphile Worker schema, dispatcher, worker process, cron registration, and a
  durable worker heartbeat task.
- S3-compatible object storage, SMTP email, OpenAI-compatible structured
  inference, and oauth2-proxy-compatible operator identity interfaces.
- Liveness and dependency-aware readiness endpoints.
- One OCI image with `web`, `worker`, `migrate`, and `admin` commands.
- Base, local, external-service, and managed Compose overlays with only Caddy
  exposed publicly.
- An allowlisted upstream sync manifest tied to an exact Belki commit and tree
  checksum.

See [Portable architecture](docs/portable-architecture.md) for boundaries and
the next implementation slices. Before changing repository visibility or
publishing an image, use the [Portable repository release checklist](docs/repository-release-checklist.md).

## Local reference stack

Requirements:

- Docker with Compose v2
- 4 GB of available memory for the reference services

Start the local stack:

```bash
docker compose -f compose.yaml -f compose.local.yaml up --build
```

Then open `http://localhost:8080`. The local overlay uses these development-only
bootstrap values:

```text
BOOTSTRAP_TOKEN=local-development-bootstrap-token-change-me
```

Mailpit is available through the same gateway at
`http://localhost:8080/mailpit/`. PostgreSQL, MinIO, Mailpit SMTP, the web
process, and the worker process remain on the private Compose network.

Stop the stack without deleting its volumes:

```bash
docker compose -f compose.yaml -f compose.local.yaml down
```

## External services

Copy `.env.example` to `.env`, configure PostgreSQL, S3-compatible storage, and
the optional SMTP/inference/billing services, then run the published image:

```bash
docker compose -f compose.yaml -f compose.external.yaml up
```

`compose.external.yaml` disables local image builds. Set `BELKI_IMAGE` to the
reviewed image tag or digest to deploy.

For managed operator SSO, add the managed overlay and configure the documented
OIDC variables:

```bash
docker compose \
  -f compose.yaml \
  -f compose.external.yaml \
  -f compose.managed.yaml \
  up
```

The managed Caddy configuration authenticates `/operator*` and
`/api/v1/operator*` through oauth2-proxy. The application accepts the resulting
identity header only when Caddy also supplies the private shared trust secret;
the public path strips caller-supplied identity and trust headers. Compose also
enables `TRUST_PROXY_HEADERS` only on the private Caddy-to-application network,
where Caddy overwrites `X-Forwarded-For`. Keep it disabled when exposing the
Node process directly.

## Development

Install and verify:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint --max-warnings 0
pnpm test
pnpm test:integration # requires TEST_DATABASE_URL
pnpm build
```

Run the client and API locally against services configured in the environment:

```bash
cp .env.example .env
pnpm db:migrate
pnpm dev
```

Useful commands:

| Command | Purpose |
|---|---|
| `pnpm db:migrate` | Apply Belki and Graphile Worker migrations |
| `pnpm start` | Run the built web/API process |
| `pnpm start:worker` | Run Graphile Worker and persistent schedules |
| `pnpm admin -- database-check` | Verify PostgreSQL connectivity |
| `pnpm admin -- usage-summary <workspace-id>` | Inspect portable usage state |
| `pnpm test:integration` | Run PostgreSQL tests when `TEST_DATABASE_URL` is set |
| `pnpm sync:check` | Verify allowlisted files against the recorded upstream commit |

## Health endpoints

- `GET /health/live` reports that the Node web process is alive.
- `GET /health/ready` verifies PostgreSQL, application migrations, the Graphile
  Worker schema, object storage, and configured inference, SMTP, Stripe, and
  operator identity modes. It returns `503` when a required dependency is not
  ready.

## Upstream synchronization

`upstream-sync.json` is the only authority for mirrored paths. `UPSTREAM.json`
records the exact canonical Belki commit, allowlisted tree hash, and file count.

```bash
pnpm sync:check
pnpm sync:apply
```

`sync:apply` copies only allowlisted paths and refreshes the record. Review its
diff like any other upstream update. Runtime adapters, PostgreSQL repositories,
migrations, deployment files, and portable tests are never copied from the
Cloudflare repository.

## Deliberate V1 boundaries

- PostgreSQL is the only relational database.
- Snapshot tables will remain unpartitioned until load tests justify a concrete
  partition strategy.
- MinIO is for development/reference deployments; production operators should
  use durable S3-compatible storage.
- D1/R2 export-import tooling is deferred. V1 supports fresh PostgreSQL
  installations.
- Docker Compose and the OCI image define the portable contract. A fully
  Vercel-native queue/cron/function edition is not currently promised.

## License and security

Belki Portable uses the same Apache-2.0 license and branding as the canonical
edition. Report vulnerabilities according to [SECURITY.md](SECURITY.md).
