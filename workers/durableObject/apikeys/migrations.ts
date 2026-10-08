// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Migration } from "../migrations";

/**
 * Migrations for the ApiKeysDO storage.
 *
 * Statements are idempotent-ready and run atomically through
 * `applyMigrations()` (which wraps them in `storage.transactionSync()`).
 */
export const apiKeysMigrations: Migration[] = [
	{
		name: "1_api_keys",
		sql: `
			CREATE TABLE api_keys (
				id           TEXT PRIMARY KEY,
				name         TEXT NOT NULL,
				prefix       TEXT NOT NULL,
				secret_hash  TEXT NOT NULL,
				mailbox_ids  TEXT NOT NULL,
				capabilities TEXT NOT NULL,
				created_at   TEXT NOT NULL,
				created_by   TEXT NOT NULL,
				last_used_at TEXT,
				expires_at   TEXT,
				revoked_at   TEXT
			);

			CREATE INDEX idx_api_keys_revoked_at ON api_keys(revoked_at);
		`,
	},
	{
		// No BEGIN/COMMIT wrapper: the DO runtime forbids SQL-level
		// transactions, see 8_add_folder_date_indexes in the mailbox migrations.
		name: "2_api_key_usage",
		sql: `
			CREATE TABLE IF NOT EXISTS api_key_usage (
				id         INTEGER PRIMARY KEY AUTOINCREMENT,
				key_id     TEXT NOT NULL,
				ts         TEXT NOT NULL,
				method     TEXT NOT NULL,
				path       TEXT NOT NULL,
				status     INTEGER NOT NULL,
				request_id TEXT
			);

			CREATE INDEX IF NOT EXISTS idx_api_key_usage_key_ts
				ON api_key_usage(key_id, ts);
		`,
	},
];
