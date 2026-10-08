// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * API keys used by external applications to reach `/api/ext/v1/*`.
 *
 * Only a SHA-256 hash of the secret is stored — the plaintext is returned
 * exactly once, at creation time.
 */
export const apiKeys = sqliteTable("api_keys", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	prefix: text("prefix").notNull(),
	secret_hash: text("secret_hash").notNull(),
	/** JSON array of mailbox IDs; `["*"]` means every mailbox. */
	mailbox_ids: text("mailbox_ids").notNull(),
	/** JSON array of capability strings. Never contains `keys:admin`. */
	capabilities: text("capabilities").notNull(),
	created_at: text("created_at").notNull(),
	created_by: text("created_by").notNull(),
	last_used_at: text("last_used_at"),
	expires_at: text("expires_at"),
	revoked_at: text("revoked_at"),
});

/** Audit trail of `/api/ext/v1/*` requests, also used for per-key rate limiting. */
export const apiKeyUsage = sqliteTable("api_key_usage", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	key_id: text("key_id").notNull(),
	ts: text("ts").notNull(),
	method: text("method").notNull(),
	path: text("path").notNull(),
	status: integer("status").notNull(),
	request_id: text("request_id"),
});
