# Contributing to Belki

Thanks for helping improve Belki Portable. Contributions should preserve the
existing HTTP/frontend contracts while keeping PostgreSQL and service adapters
independent of a specific hosting platform.

## Development setup

You need Node.js 22 or newer, pnpm 11, and PostgreSQL 16+ for integration tests.

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm db:migrate
pnpm dev
```

Use test credentials or inert placeholders in `.env`. Never add real secrets,
customer data, provider responses, service credentials, or private deployment
output to Git.

## Making a change

1. Create a focused branch from the latest `main`.
2. Keep runtime behavior, migrations, tests, and documentation in sync.
3. Add PostgreSQL migrations instead of editing an already released migration.
4. Run the complete validation suite before opening a pull request.

```bash
pnpm check
TEST_DATABASE_URL=postgresql://... pnpm test:integration
pnpm sync:check
```

`sync:check` expects the canonical `belki` checkout at `../belki` unless
`BELKI_UPSTREAM_PATH` or `UPSTREAM.local.json` points elsewhere. CI uses
`sync:check:record` to validate the checked-in allowlisted tree against
`UPSTREAM.json` without requiring access to another repository.

Changes to managed billing, authentication, tenant isolation, migrations,
upstream sync paths, or destructive retention need an explicit review note
explaining their production impact and rollback plan.

## Pull requests

Describe the user-visible result, test evidence, schema or configuration
changes, and any manual rollout steps. Keep unrelated refactors separate. Do
not include generated build output or private evaluation fixtures.

By contributing, you agree that your contribution is licensed under the
repository's Apache-2.0 license.
