# Portable repository release checklist

This checklist separates sharing the source repository from declaring a
production-ready Belki Portable release. A private development repository may
be created while product parity is incomplete; production tags and public
visibility require the complete release checks.

## Every pushed change

- [ ] `pnpm install --frozen-lockfile` succeeds on Node.js 22.
- [ ] `pnpm check` passes.
- [ ] `pnpm sync:check:record` matches `UPSTREAM.json`.
- [ ] PostgreSQL integration tests pass with `TEST_DATABASE_URL` configured.
- [ ] The OCI image builds and all Compose overlays pass `docker compose config`.
- [ ] No `.env`, credentials, customer data, provider payloads, database dumps,
      private evaluation fixtures, or production logs are tracked.

## Before a production tag

- [ ] Start from empty PostgreSQL, S3-compatible storage, and SMTP services.
- [ ] Apply application and Graphile Worker migrations twice to verify
      idempotent startup.
- [ ] Complete bootstrap, sign-in, project creation, and prompt onboarding.
- [ ] Exercise every feature claimed in the release notes, including retry and
      restart behavior for background work.
- [ ] Confirm only Caddy exposes host ports in the supported Compose topology.
- [ ] Test backup and restore for PostgreSQL and object storage.
- [ ] Publish an immutable image tag and digest, then deploy that exact digest.
- [ ] Record the canonical Belki commit and portable schema changes in the
      release notes.

## Before making the repository public

- [ ] Scan the complete Git history and current tree for secrets.
- [ ] Enable branch protection and private vulnerability reporting.
- [ ] Confirm `LICENSE`, `NOTICE`, `SECURITY.md`, and `CONTRIBUTING.md` render as
      intended.
- [ ] Remove internal planning artifacts and deployment-specific identifiers.
- [ ] State incomplete feature-parity boundaries prominently in the README.
- [ ] Obtain explicit maintainer approval for the visibility change.

Changing GitHub visibility never authorizes deploying an image or changing a
running installation.
