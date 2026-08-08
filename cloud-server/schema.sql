-- Run the Better Auth migration first, then import this file into the same MySQL database.
CREATE TABLE IF NOT EXISTS firefly_storage_accounts (
  user_id VARCHAR(255) NOT NULL PRIMARY KEY,
  quota_bytes BIGINT UNSIGNED NOT NULL DEFAULT 157286400,
  usage_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS firefly_desktop_codes (
  code_hash CHAR(64) NOT NULL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_firefly_desktop_codes_user (user_id),
  INDEX idx_firefly_desktop_codes_expiry (expires_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS firefly_api_tokens (
  token_hash CHAR(64) NOT NULL PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  device_name VARCHAR(160) NOT NULL,
  last_used_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_firefly_api_tokens_user (user_id),
  INDEX idx_firefly_api_tokens_expiry (expires_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS firefly_sync_objects (
  user_id VARCHAR(255) NOT NULL,
  content_hash CHAR(64) NOT NULL,
  original_name VARCHAR(190) NOT NULL,
  storage_name VARCHAR(255) NOT NULL,
  size_bytes BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, content_hash),
  INDEX idx_firefly_sync_objects_user (user_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS firefly_sync_snapshots (
  user_id VARCHAR(255) NOT NULL PRIMARY KEY,
  storage_name VARCHAR(255) NOT NULL,
  size_bytes BIGINT UNSIGNED NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  device_name VARCHAR(160) NOT NULL,
  synced_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;
