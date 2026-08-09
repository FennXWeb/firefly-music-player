-- PostgreSQL / Supabase schema for Ignifire cloud data.
-- Run the Better Auth migration first, then execute this file in the Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS public.firefly_storage_accounts (
  user_id TEXT PRIMARY KEY,
  quota_bytes BIGINT NOT NULL DEFAULT 157286400 CHECK (quota_bytes >= 0),
  usage_bytes BIGINT NOT NULL DEFAULT 0 CHECK (usage_bytes >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.firefly_desktop_codes (
  code_hash CHAR(64) PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_firefly_desktop_codes_user
  ON public.firefly_desktop_codes (user_id);
CREATE INDEX IF NOT EXISTS idx_firefly_desktop_codes_expiry
  ON public.firefly_desktop_codes (expires_at);

CREATE TABLE IF NOT EXISTS public.firefly_api_tokens (
  token_hash CHAR(64) PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_name VARCHAR(160) NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_firefly_api_tokens_user
  ON public.firefly_api_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_firefly_api_tokens_expiry
  ON public.firefly_api_tokens (expires_at);

CREATE TABLE IF NOT EXISTS public.firefly_sync_objects (
  user_id TEXT NOT NULL,
  content_hash CHAR(64) NOT NULL,
  original_name VARCHAR(190) NOT NULL,
  storage_name VARCHAR(255) NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_firefly_sync_objects_user
  ON public.firefly_sync_objects (user_id);

CREATE TABLE IF NOT EXISTS public.firefly_sync_snapshots (
  user_id TEXT PRIMARY KEY,
  storage_name VARCHAR(255) NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  device_name VARCHAR(160) NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- These tables are accessed only by the trusted Node service through its
-- PostgreSQL connection. No anon/authenticated Data API policies are created.
ALTER TABLE public.firefly_storage_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firefly_desktop_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firefly_api_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firefly_sync_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firefly_sync_snapshots ENABLE ROW LEVEL SECURITY;

-- Better Auth also stores security-sensitive records in the public schema.
-- Enable RLS for every core/plugin table that its migration created. Revoke
-- Supabase Data API roles when those roles exist; the server's PostgreSQL
-- owner connection continues to work while browser clients get no direct DB
-- access to account, token, passkey, or sync records.
DO $$
DECLARE
  table_name TEXT;
  role_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'user', 'session', 'account', 'verification', 'passkey', 'rateLimit',
    'firefly_storage_accounts', 'firefly_desktop_codes',
    'firefly_api_tokens', 'firefly_sync_objects', 'firefly_sync_snapshots'
  ] LOOP
    IF to_regclass(format('%I.%I', 'public', table_name)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', 'public', table_name);
      FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
          EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I', 'public', table_name, role_name);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END
$$;
