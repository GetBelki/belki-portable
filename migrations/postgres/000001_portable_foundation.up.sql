CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  public_base_url text NOT NULL,
  monthly_run_cap bigint NOT NULL DEFAULT 1000000 CHECK (monthly_run_cap >= 0),
  timezone text NOT NULL DEFAULT 'UTC',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending_payment', 'active', 'read_only', 'suspended', 'deleted')),
  plan_key text NOT NULL DEFAULT 'self_hosted'
    CHECK (plan_key IN ('self_hosted', 'starter', 'studio', 'agency', 'custom')),
  read_only_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE password_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  algorithm text NOT NULL DEFAULT 'pbkdf2-sha256',
  iterations integer NOT NULL CHECK (iterations > 0),
  salt text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id, status);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  csrf_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip_hash text,
  user_agent text,
  active_workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX sessions_token_expiry_idx ON sessions (token_hash, expires_at);

CREATE TABLE platform_operators (
  email text PRIMARY KEY,
  user_id uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  primary_domain text,
  html_capture_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX projects_workspace_idx ON projects (workspace_id, deleted_at);

CREATE TABLE billing_accounts (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('stripe', 'manual', 'self_hosted')),
  payment_mode text NOT NULL
    CHECK (payment_mode IN ('disabled', 'stripe_managed', 'stripe_direct')),
  plan_key text NOT NULL CHECK (plan_key IN ('self_hosted', 'starter', 'studio', 'agency', 'custom')),
  status text NOT NULL
    CHECK (status IN ('pending', 'trialing', 'active', 'past_due', 'unpaid', 'cancelled', 'paused')),
  monthly_units bigint NOT NULL CHECK (monthly_units >= 0),
  project_limit integer NOT NULL CHECK (project_limit >= 0),
  prompt_limit integer NOT NULL CHECK (prompt_limit >= 0),
  source_limit integer NOT NULL CHECK (source_limit >= 0),
  cycle_started_at timestamptz NOT NULL,
  cycle_ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  resource_type text,
  resource_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rate_limits (
  key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);

CREATE TABLE usage_entitlements (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_key text NOT NULL CHECK (plan_key IN ('self_hosted', 'starter', 'studio', 'agency', 'custom')),
  subscription_status text NOT NULL
    CHECK (subscription_status IN ('pending', 'trialing', 'active', 'past_due', 'unpaid', 'cancelled', 'paused')),
  workspace_status text NOT NULL
    CHECK (workspace_status IN ('pending_payment', 'active', 'read_only', 'suspended', 'deleted')),
  allowance bigint NOT NULL CHECK (allowance >= 0),
  project_limit integer NOT NULL CHECK (project_limit >= 0),
  prompt_limit integer NOT NULL CHECK (prompt_limit >= 0),
  source_limit integer NOT NULL CHECK (source_limit >= 0),
  cycle_started_at timestamptz NOT NULL,
  cycle_ends_at timestamptz NOT NULL,
  read_only_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_reservations (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL,
  sku text NOT NULL
    CHECK (sku IN ('llm_standard', 'llm_priority_html', 'llm_live', 'entity_extraction', 'product_enrichment')),
  units integer NOT NULL CHECK (units > 0),
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved', 'committed', 'released')),
  cycle_started_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, reservation_id)
);
CREATE INDEX usage_reservations_cycle_status_idx
  ON usage_reservations (workspace_id, cycle_started_at, status);

CREATE TABLE usage_resource_claims (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  claim_id uuid NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN ('project', 'prompt')),
  resource_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('claimed', 'released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, claim_id, resource_id)
);
CREATE UNIQUE INDEX usage_resource_claims_active_resource_idx
  ON usage_resource_claims (workspace_id, resource_kind, resource_id)
  WHERE status = 'claimed';
CREATE INDEX usage_resource_claims_count_idx
  ON usage_resource_claims (workspace_id, resource_kind, status);

CREATE TABLE worker_heartbeats (
  worker_name text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
