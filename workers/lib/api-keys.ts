// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * API key helpers for the external API surface (`/api/ext/v1/*`).
 *
 * Split in two parts:
 *  - pure helpers (key format, hashing, scope checks) — unit tested;
 *  - the Hono middleware that authenticates a request against ApiKeysDO.
 *
 * Security model: the plaintext secret is generated in the Worker, only its
 * SHA-256 digest is stored, and the digest (never the secret) is what crosses
 * the Durable Object RPC boundary for comparison.
 */

import { createMiddleware } from "hono/factory";
import type { Env } from "../types";
import type { ApiKeyRecord, ApiKeysDO, AuthorizeResult } from "../durableObject/apikeys";

// ── Constants ──────────────────────────────────────────────────────

/** Human-recognisable key prefix: `ain_<keyId>_<secret>`. */
export const API_KEY_PREFIX = "ain";

/** keyId length in characters (identifier, not a secret). */
export const API_KEY_ID_LENGTH = 8;

/** Secret length in random bytes (base64url-encoded to 43 characters). */
export const API_KEY_SECRET_BYTES = 32;

/** Default per-key request budget. */
export const API_KEY_RATE_LIMIT_PER_MINUTE = 120;

/**
 * Capabilities an external key can hold.
 *
 * `keys:admin` is deliberately absent: a leaked key must never be able to
 * mint or revoke keys (see docs/newsletter-design.md §4.3).
 */
export const API_KEY_CAPABILITIES = [
	"subscribers:read",
	"subscribers:write",
	"campaigns:read",
	"campaigns:write",
	"campaigns:send",
] as const;

export type ApiKeyCapability = (typeof API_KEY_CAPABILITIES)[number];

/** 32 characters, no look-alike glyphs (0/1/l/o removed). */
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

// ── Pure helpers ───────────────────────────────────────────────────

/** Hex-encoded SHA-256 digest of a UTF-8 string. */
export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export interface GeneratedApiKey {
	keyId: string;
	/** Display-only, e.g. `ain_ab12cd34`. */
	prefix: string;
	/** Full plaintext key — returned to the operator exactly once. */
	plaintext: string;
	/** SHA-256 of `secret`; this is what gets stored. */
	secretHash: string;
}

/**
 * Generate a new key. `256 % ALPHABET.length === 0`, so the modulo is
 * bias-free for the 32-character alphabet.
 */
export async function generateApiKey(): Promise<GeneratedApiKey> {
	const idBytes = new Uint8Array(API_KEY_ID_LENGTH);
	crypto.getRandomValues(idBytes);
	let keyId = "";
	for (const byte of idBytes) keyId += ALPHABET[byte % ALPHABET.length];

	const secretBytes = new Uint8Array(API_KEY_SECRET_BYTES);
	crypto.getRandomValues(secretBytes);
	const secret = toBase64Url(secretBytes);

	return {
		keyId,
		prefix: `${API_KEY_PREFIX}_${keyId}`,
		plaintext: `${API_KEY_PREFIX}_${keyId}_${secret}`,
		secretHash: await sha256Hex(secret),
	};
}

/** Parse `ain_<keyId>_<secret>`; returns null when malformed. */
export function parseApiKey(
	plaintext: string,
): { prefix: string; keyId: string; secret: string } | null {
	const match = /^ain_([a-z0-9]{8})_([A-Za-z0-9_-]{16,128})$/.exec(plaintext.trim());
	if (!match) return null;
	return { prefix: `${API_KEY_PREFIX}_${match[1]}`, keyId: match[1], secret: match[2] };
}

/** Extract the bearer token from an `Authorization` header value. */
export function bearerToken(headerValue: string | undefined): string | null {
	if (!headerValue) return null;
	const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
	return match ? match[1].trim() : null;
}

/** Safe JSON-array parse; never throws. */
export function parseStringArray(json: string | null | undefined): string[] {
	if (!json) return [];
	try {
		const parsed: unknown = JSON.parse(json);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === "string");
	} catch {
		return [];
	}
}

/** Keep only known capabilities, de-duplicated, order preserved. */
export function sanitizeCapabilities(input: readonly string[]): ApiKeyCapability[] {
	const allowed = new Set<string>(API_KEY_CAPABILITIES);
	const seen = new Set<string>();
	const out: ApiKeyCapability[] = [];
	for (const capability of input) {
		if (!allowed.has(capability) || seen.has(capability)) continue;
		seen.add(capability);
		out.push(capability as ApiKeyCapability);
	}
	return out;
}

/** Normalise a mailbox scope list: lowercase, trimmed, de-duplicated. */
export function normalizeMailboxIds(input: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of input) {
		const value = raw.trim().toLowerCase();
		if (!value || seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return out;
}

export function hasCapability(
	record: Pick<ApiKeyRecord, "capabilities">,
	capability: ApiKeyCapability,
): boolean {
	return parseStringArray(record.capabilities).includes(capability);
}

/** `["*"]` grants every mailbox; otherwise an exact (case-insensitive) match. */
export function isMailboxAllowed(
	record: Pick<ApiKeyRecord, "mailbox_ids">,
	mailboxId: string,
): boolean {
	const scopes = parseStringArray(record.mailbox_ids).map((id) => id.toLowerCase());
	return scopes.includes("*") || scopes.includes(mailboxId.toLowerCase());
}

/** Mailboxes this key may touch, given the account's full mailbox list. */
export function filterAllowedMailboxes<T extends { id: string }>(
	record: Pick<ApiKeyRecord, "mailbox_ids">,
	mailboxes: readonly T[],
): T[] {
	const scopes = parseStringArray(record.mailbox_ids).map((id) => id.toLowerCase());
	if (scopes.includes("*")) return [...mailboxes];
	return mailboxes.filter((mailbox) => scopes.includes(mailbox.id.toLowerCase()));
}

export function isKeyActive(
	record: Pick<ApiKeyRecord, "revoked_at" | "expires_at">,
	now: Date = new Date(),
): boolean {
	if (record.revoked_at) return false;
	if (record.expires_at && Date.parse(record.expires_at) <= now.getTime()) return false;
	return true;
}

/** Wire format for keys: JSON columns expanded into arrays, hash never included. */
export interface ApiKeyView {
	id: string;
	name: string;
	prefix: string;
	mailboxIds: string[];
	capabilities: string[];
	createdAt: string;
	createdBy: string;
	lastUsedAt: string | null;
	expiresAt: string | null;
	revokedAt: string | null;
}

export function toApiKeyView(record: ApiKeyRecord): ApiKeyView {
	return {
		id: record.id,
		name: record.name,
		prefix: record.prefix,
		mailboxIds: parseStringArray(record.mailbox_ids),
		capabilities: parseStringArray(record.capabilities),
		createdAt: record.created_at,
		createdBy: record.created_by,
		lastUsedAt: record.last_used_at,
		expiresAt: record.expires_at,
		revokedAt: record.revoked_at,
	};
}

// ── Durable Object access ──────────────────────────────────────────

/** Single global instance holding every key. */
export function getApiKeysStub(env: Env): DurableObjectStub<ApiKeysDO> {
	const id = env.API_KEYS.idFromName("global");
	return env.API_KEYS.get(id);
}

// ── Middleware ─────────────────────────────────────────────────────

export type ApiKeyContext = {
	Bindings: Env;
	Variables: {
		apiKey: ApiKeyRecord;
	};
};

function failureMessage(reason: Exclude<AuthorizeResult, { ok: true }>["reason"]): string {
	switch (reason) {
		case "revoked":
			return "API key has been revoked";
		case "expired":
			return "API key has expired";
		case "rate_limited":
			return "Rate limit exceeded";
		default:
			return "Invalid API key";
	}
}

/**
 * Authenticate an external request and attach the key record as `apiKey`.
 *
 * Does not check capabilities — routes that need one use `requireCapability`.
 */
export const requireApiKey = createMiddleware<ApiKeyContext>(async (c, next) => {
	const token = bearerToken(c.req.header("authorization"));
	if (!token) {
		return c.json({ error: "Missing Authorization: Bearer <api key>" }, 401);
	}

	const parsed = parseApiKey(token);
	if (!parsed) {
		return c.json({ error: "Malformed API key" }, 401);
	}

	const stub = getApiKeysStub(c.env);
	const secretHash = await sha256Hex(parsed.secret);
	const result = await stub.authorize({
		keyId: parsed.keyId,
		secretHash,
		rateLimitPerMinute: API_KEY_RATE_LIMIT_PER_MINUTE,
	});

	if (!result.ok) {
		if (result.reason === "rate_limited" && result.retryAfterSeconds) {
			c.header("Retry-After", String(result.retryAfterSeconds));
		}
		return c.json(
			{ error: failureMessage(result.reason) },
			result.reason === "rate_limited" ? 429 : 401,
		);
	}

	c.set("apiKey", result.key);

	await next();

	c.executionCtx.waitUntil(
		stub
			.recordUsage({
				keyId: result.key.id,
				method: c.req.method,
				path: new URL(c.req.url).pathname,
				status: c.res.status,
				requestId: c.req.header("cf-ray") ?? null,
			})
			.catch((e: unknown) => {
				console.error("Failed to record API key usage:", (e as Error).message);
			}),
	);
});

/** Reject requests whose key lacks `capability`. Must run after `requireApiKey`. */
export function requireCapability(capability: ApiKeyCapability) {
	return createMiddleware<ApiKeyContext>(async (c, next) => {
		const key = c.get("apiKey");
		if (!hasCapability(key, capability)) {
			return c.json(
				{ error: `API key is missing the required capability: ${capability}` },
				403,
			);
		}
		await next();
	});
}

// ── Internal utilities ─────────────────────────────────────────────

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
