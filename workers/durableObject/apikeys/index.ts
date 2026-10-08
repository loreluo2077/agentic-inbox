// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { desc, eq } from "drizzle-orm";
import * as schema from "./schema";
import type { Env } from "../../types";
import { applyMigrations } from "../migrations";
import { apiKeysMigrations } from "./migrations";

/** How long per-request usage rows are kept (rate limiting only needs minutes). */
const USAGE_RETENTION_DAYS = 7;

/** Run the usage cleanup once every N recorded requests. */
const USAGE_CLEANUP_EVERY = 200;

/** Rate limiting window, in seconds. */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * A stored API key, without the secret hash (never leaves the DO).
 */
export interface ApiKeyRecord {
	id: string;
	name: string;
	prefix: string;
	/** JSON array of mailbox IDs; `["*"]` means every mailbox. */
	mailbox_ids: string;
	/** JSON array of capability strings. */
	capabilities: string;
	created_at: string;
	created_by: string;
	last_used_at: string | null;
	expires_at: string | null;
	revoked_at: string | null;
}

export type AuthorizeResult =
	| { ok: true; key: ApiKeyRecord }
	| {
			ok: false;
			reason: "invalid" | "revoked" | "expired" | "rate_limited";
			retryAfterSeconds?: number;
	  };

/**
 * ApiKeysDO — singleton Durable Object (name `global`) holding external
 * application API keys and their usage audit trail.
 *
 * Kept separate from MailboxDO because keys are account-wide: a key is
 * scoped to one or more mailboxes, not owned by one.
 */
export class ApiKeysDO extends DurableObject<Env> {
	declare __DURABLE_OBJECT_BRAND: never;
	db: ReturnType<typeof drizzle>;

	#usageWrites = 0;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.db = drizzle(this.ctx.storage, { schema });
		applyMigrations(this.ctx.storage.sql, apiKeysMigrations, this.ctx.storage);
	}

	// ── Key lifecycle ──────────────────────────────────────────────

	async insertKey(input: {
		id: string;
		name: string;
		prefix: string;
		secretHash: string;
		mailboxIds: string[];
		capabilities: string[];
		createdBy: string;
		expiresAt?: string | null;
	}): Promise<ApiKeyRecord> {
		const record: ApiKeyRecord = {
			id: input.id,
			name: input.name,
			prefix: input.prefix,
			mailbox_ids: JSON.stringify(input.mailboxIds),
			capabilities: JSON.stringify(input.capabilities),
			created_at: new Date().toISOString(),
			created_by: input.createdBy,
			last_used_at: null,
			expires_at: input.expiresAt ?? null,
			revoked_at: null,
		};

		this.db
			.insert(schema.apiKeys)
			.values({ ...record, secret_hash: input.secretHash })
			.run();

		return record;
	}

	async listKeys(): Promise<ApiKeyRecord[]> {
		return this.db
			.select({
				id: schema.apiKeys.id,
				name: schema.apiKeys.name,
				prefix: schema.apiKeys.prefix,
				mailbox_ids: schema.apiKeys.mailbox_ids,
				capabilities: schema.apiKeys.capabilities,
				created_at: schema.apiKeys.created_at,
				created_by: schema.apiKeys.created_by,
				last_used_at: schema.apiKeys.last_used_at,
				expires_at: schema.apiKeys.expires_at,
				revoked_at: schema.apiKeys.revoked_at,
			})
			.from(schema.apiKeys)
			.orderBy(desc(schema.apiKeys.created_at))
			.all();
	}

	async revokeKey(id: string): Promise<boolean> {
		const existing = this.db
			.select({ id: schema.apiKeys.id, revoked_at: schema.apiKeys.revoked_at })
			.from(schema.apiKeys)
			.where(eq(schema.apiKeys.id, id))
			.get();

		if (!existing || existing.revoked_at) return false;

		this.db
			.update(schema.apiKeys)
			.set({ revoked_at: new Date().toISOString() })
			.where(eq(schema.apiKeys.id, id))
			.run();

		return true;
	}

	// ── Request authorization ──────────────────────────────────────

	/**
	 * Single round trip for the hot path: look up the key, compare the
	 * secret hash, check revocation/expiry, enforce the per-key rate limit,
	 * and stamp `last_used_at`.
	 *
	 * The plaintext secret never enters the Durable Object — the caller
	 * sends `sha256Hex(secret)` and the stored hash is compared inside.
	 */
	async authorize(input: {
		keyId: string;
		secretHash: string;
		rateLimitPerMinute: number;
		now?: Date;
	}): Promise<AuthorizeResult> {
		const row = this.db
			.select()
			.from(schema.apiKeys)
			.where(eq(schema.apiKeys.id, input.keyId))
			.get();

		if (!row || !secretsMatch(row.secret_hash, input.secretHash)) {
			return { ok: false, reason: "invalid" };
		}

		const now = input.now ?? new Date();

		if (row.revoked_at) return { ok: false, reason: "revoked" };

		if (row.expires_at && Date.parse(row.expires_at) <= now.getTime()) {
			return { ok: false, reason: "expired" };
		}

		const recent = this.#countRecentRequests(row.id, RATE_LIMIT_WINDOW_SECONDS, now);
		if (recent >= input.rateLimitPerMinute) {
			return { ok: false, reason: "rate_limited", retryAfterSeconds: RATE_LIMIT_WINDOW_SECONDS };
		}

		const lastUsedAt = now.toISOString();
		this.db
			.update(schema.apiKeys)
			.set({ last_used_at: lastUsedAt })
			.where(eq(schema.apiKeys.id, row.id))
			.run();

		return {
			ok: true,
			key: {
				id: row.id,
				name: row.name,
				prefix: row.prefix,
				mailbox_ids: row.mailbox_ids,
				capabilities: row.capabilities,
				created_at: row.created_at,
				created_by: row.created_by,
				last_used_at: lastUsedAt,
				expires_at: row.expires_at,
				revoked_at: row.revoked_at,
			},
		};
	}

	/** Append an audit row for a completed request. Safe to call from `waitUntil`. */
	async recordUsage(input: {
		keyId: string;
		method: string;
		path: string;
		status: number;
		requestId?: string | null;
	}): Promise<void> {
		this.db
			.insert(schema.apiKeyUsage)
			.values({
				key_id: input.keyId,
				ts: new Date().toISOString(),
				method: input.method,
				path: input.path,
				status: input.status,
				request_id: input.requestId ?? null,
			})
			.run();

		this.#usageWrites++;
		if (this.#usageWrites >= USAGE_CLEANUP_EVERY) {
			this.#usageWrites = 0;
			this.ctx.storage.sql.exec(
				`DELETE FROM api_key_usage WHERE ts < datetime('now', ?1)`,
				`-${USAGE_RETENTION_DAYS} days`,
			);
		}
	}

	/** Number of recorded requests for a key inside the trailing window. */
	#countRecentRequests(keyId: string, windowSeconds: number, now: Date): number {
		const since = new Date(now.getTime() - windowSeconds * 1000).toISOString();
		const row = [
			...this.ctx.storage.sql.exec(
				`SELECT COUNT(*) AS total FROM api_key_usage WHERE key_id = ?1 AND ts >= ?2`,
				keyId,
				since,
			),
		][0] as { total: number } | undefined;
		return row?.total ?? 0;
	}
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Length is compared first (that is not secret-dependent for fixed-size
 * SHA-256 output), then every character is folded into an accumulator so
 * the loop duration does not depend on where the first mismatch is.
 */
function secretsMatch(storedHex: string, providedHex: string): boolean {
	if (storedHex.length !== providedHex.length) return false;

	let diff = 0;
	for (let i = 0; i < storedHex.length; i++) {
		diff |= storedHex.charCodeAt(i) ^ providedHex.charCodeAt(i);
	}
	return diff === 0;
}
